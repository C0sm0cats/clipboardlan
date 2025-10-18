console.log('Background script loaded');

const MAX_HISTORY = 3;
const MAX_RECONNECT_ATTEMPTS = 5;
let clipboardHistory = [];
let lastClipboardContent = '';
let socket = null;
let isConnected = false;
let reconnectAttempts = 0;
let reconnectTimeout = null;
const PING_INTERVAL = 25000;
let pingInterval = null;
let machineId = '';
let localMachineId = '';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'CLEAR_HISTORY') {
    chrome.storage.local.set({ clipboardHistory: [] });
    // Optionally notify server to clear history if applicable
    sendResponse({ success: true });
  }
});

async function detectLocalIP() {
  return new Promise((resolve) => {
    const pc = new RTCPeerConnection({ iceServers: [] });
    pc.createDataChannel("");
    pc.createOffer().then((offer) => pc.setLocalDescription(offer));
    pc.onicecandidate = (event) => {
      if (event && event.candidate && event.candidate.candidate) {
        const ipMatch = event.candidate.candidate.match(/(\d+\.\d+\.\d+\.\d+)/);
        if (ipMatch) {
          resolve(ipMatch[1]);
          pc.close();
        }
      }
    };
    setTimeout(() => resolve("localhost"), 1000);
  });
}

function updateHistory(content, source = 'local', machineId = '') {
  if (content && content.trim() !== '' && content !== lastClipboardContent) {
    const timestamp = new Date().toISOString();
    const newItem = { 
      content, 
      timestamp, 
      source,
      machine_id: machineId || localMachineId
    };

    // Remove any existing item with the same content to avoid duplicates
    clipboardHistory = clipboardHistory.filter(item => item.content !== content);
    clipboardHistory.unshift(newItem);
    if (clipboardHistory.length > MAX_HISTORY) {
      clipboardHistory = clipboardHistory.slice(0, MAX_HISTORY);
    }
    lastClipboardContent = content;
    chrome.storage.local.set({ clipboardHistory }, () => {
      console.log('[DEBUG] Historique mis à jour:', clipboardHistory);
    });
    try {
      chrome.runtime.sendMessage({
        type: 'clipboard_update',
        history: clipboardHistory
      }).catch(error => {
        if (error.message !== 'Could not establish connection. Receiving end does not exist.') {
          console.error('[ERREUR] Erreur lors de l\'envoi de la mise à jour au popup:', error);
        }
      });
    } catch (e) {
      console.error('[ERREUR] Erreur lors de l\'envoi de la mise à jour au popup:', e);
    }
    
    if (isConnected && socket && socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify({
          type: 'clipboard_update',
          content: content,
          timestamp: timestamp,
          source: 'local',
          machine_id: localMachineId
        }));
        console.log('[DEBUG] Mise à jour envoyée au serveur:', content);
      } catch (e) {
        console.error('[ERREUR] Erreur lors de l\'envoi au serveur:', e);
      }
    }
  }
}

async function updateExtensionIcon(connected) {
  const statusText = connected ? 'ON' : 'OFF';
  const title = connected ? 'ClipboardLan: Connecté' : 'ClipboardLan: Déconnecté';
  const color = connected ? '#4CAF50' : '#F44336';

  try {
    await chrome.action.setBadgeText({ text: '' });
    await chrome.action.setBadgeText({ text: statusText });
    await chrome.action.setBadgeBackgroundColor({ color });
    await chrome.action.setBadgeTextColor({ color: '#FFFFFF' });
    await chrome.action.setTitle({ title });
  } catch (error) {
    console.error(`[ERREUR] Échec de la mise à jour du badge: ${error.message}`);
    setTimeout(async () => {
      try {
        await chrome.action.setBadgeText({ text: '' });
        await chrome.action.setBadgeText({ text: statusText });
        await chrome.action.setBadgeBackgroundColor({ color });
        await chrome.action.setBadgeTextColor({ color: '#FFFFFF' });
        await chrome.action.setTitle({ title });
      } catch (retryError) {
        console.error('[ERREUR] Échec de la deuxième tentative de mise à jour:', retryError);
      }
    }, 300);
  }
  return Promise.resolve();
}

async function updateConnectionStatus(connected, message = '') {
  const wasConnected = isConnected;
  isConnected = connected;

  try {
    await chrome.storage.local.set({ isConnected: connected });
    await updateExtensionIcon(connected);
  } catch (error) {
    console.error('[ERREUR] Échec de la mise à jour du statut:', error);
  }

  if (!connected && pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }

  chrome.storage.local.get(['serverIp', 'serverPort'], (result) => {
    let statusMessage = message || (connected ? 'Connected to server' : 'Disconnected');
    if (connected && result.serverIp && result.serverPort) {
      statusMessage = `Connected to ${result.serverIp}:${result.serverPort}`;
    }
    chrome.storage.local.set({
      isConnected: connected,
      serverIp: result.serverIp,
      serverPort: result.serverPort
    });
    sendStatusUpdate(connected, statusMessage);
  });
}

function sendStatusUpdate(connected, message) {
  chrome.runtime.sendMessage({
    type: 'STATUS_UPDATE',
    message,
    success: connected
  }).catch(() => {});
}

const WS_RECONNECT_BASE_DELAY = 1000;
const WS_MAX_RECONNECT_ATTEMPTS = 10;
const WS_PING_INTERVAL = 25000;
const WS_CONNECTION_TIMEOUT = 10000;

function calculateReconnectDelay(attempt) {
  return Math.min(WS_RECONNECT_BASE_DELAY * Math.pow(2, attempt), 30000);
}

function attemptWebSocketConnection(serverIp, serverPort) {
  if (reconnectTimeout) clearTimeout(reconnectTimeout);
  if (socket) {
    try { socket.close(); } catch (e) {}
    socket = null;
  }

  chrome.storage.local.set({ serverIp, serverPort });
  const wsUrl = `ws://${serverIp}:${serverPort}/ws`;
  console.log(`[WS] Tentative de connexion: ${wsUrl}`);

  try {
    socket = new WebSocket(wsUrl);
    const connectionTimeout = setTimeout(() => {
      if (socket && socket.readyState === WebSocket.CONNECTING) {
        console.error('[WS] Timeout de connexion WebSocket (10s)');
        socket.close();
        handleReconnection(serverIp, serverPort);
      }
    }, WS_CONNECTION_TIMEOUT);

    socket.onopen = () => {
      clearTimeout(connectionTimeout);
      console.log('[WS] Connexion WebSocket établie');
      isConnected = true;
      reconnectAttempts = 0;
      updateConnectionStatus(true, 'Connecté au serveur');
      if (pingInterval) clearInterval(pingInterval);
      pingInterval = setInterval(() => {
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
        }
      }, WS_PING_INTERVAL);
      sendClientInfo();
      socket.send(JSON.stringify({ type: 'get_history' }));
    };

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'clipboard_update' && data.content) {
          const isFromOtherMachine = data.machine_id && data.machine_id !== localMachineId;
          if (isFromOtherMachine) updateHistory(data.content, 'remote', data.machine_id);
        } else if (data.type === 'client_id' && data.client_id) {
          machineId = data.client_id;
        } else if (data.type === 'history' && data.history) {
          // Merge server history with local history, avoiding duplicates
          const uniqueHistory = [];
          const seenContent = new Set(clipboardHistory.map(item => item.content));
          for (const item of data.history) {
            if (!seenContent.has(item.content)) {
              seenContent.add(item.content);
              uniqueHistory.push({
                content: item.content,
                timestamp: item.timestamp,
                source: item.source || 'remote',
                machine_id: item.machine_id,
                hostname: item.hostname
              });
            }
          }
          clipboardHistory = [...uniqueHistory, ...clipboardHistory].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, MAX_HISTORY);
          chrome.storage.local.set({ clipboardHistory }, () => {
            console.log('[DEBUG] Server history synced:', clipboardHistory);
            chrome.runtime.sendMessage({
              type: 'clipboard_update',
              history: clipboardHistory
            }).catch(error => {
              if (error.message !== 'Could not establish connection. Receiving end does not exist.') {
                console.error('[ERREUR] Erreur lors de l\'envoi de la mise à jour au popup:', error);
              }
            });
          });
        }
      } catch (e) {
        console.error('[WS] Erreur message:', e);
      }
    };

    socket.onclose = (event) => {
      clearTimeout(connectionTimeout);
      console.log(`[WS] Fermeture: ${event.code}`);
      isConnected = false;
      if (pingInterval) clearInterval(pingInterval);
      if (event.code !== 1000) handleReconnection(serverIp, serverPort);
      else updateConnectionStatus(false, 'Déconnecté');
    };

    socket.onerror = (error) => {
      clearTimeout(connectionTimeout);
      console.error('[WS] Erreur:', error);
      isConnected = false;
      updateConnectionStatus(false, 'Erreur de connexion');
      handleReconnection(serverIp, serverPort);
    };

  } catch (e) {
    console.error('[ERREUR] Création WebSocket:', e);
    updateConnectionStatus(false, 'Connection failed: ' + (e.message || 'Unknown'));
    handleReconnection(serverIp, serverPort);
  }
}

function handleReconnection(serverIp, serverPort) {
  if (reconnectAttempts >= WS_MAX_RECONNECT_ATTEMPTS) {
    updateConnectionStatus(false, `Failed to connect after ${WS_MAX_RECONNECT_ATTEMPTS} attempts`);
    return;
  }
  const delay = calculateReconnectDelay(reconnectAttempts);
  reconnectTimeout = setTimeout(() => attemptWebSocketConnection(serverIp, serverPort), delay);
  reconnectAttempts++;
}

function cleanupConnection() {
  if (socket) {
    try { socket.close(); } catch (e) {}
    socket = null;
  }
  if (pingInterval) clearInterval(pingInterval);
  if (reconnectTimeout) clearTimeout(reconnectTimeout);
  isConnected = false;
}

chrome.runtime.onSuspend.addListener(cleanupConnection);

chrome.runtime.onMessage.addListener(async (request, sender, sendResponse) => {
  switch (request.type) {
    case 'CLIPBOARD_CHANGE':
      if (request.content) updateHistory(request.content, 'local');
      sendResponse({ success: true });
      return true;

    case 'GET_CONNECTION_STATUS':
      sendResponse({ connected: isConnected && socket && socket.readyState === WebSocket.OPEN });
      return true;

    case 'CONNECT':
      let serverIp = request.ip;
      const serverPort = request.port || '24900';

      if (!serverIp || serverIp === '0.0.0.0' || serverIp === 'localhost') {
        console.log('[INFO] Détection automatique de l’adresse IP locale...');
        try {
          serverIp = await detectLocalIP();
          console.log(`[INFO] IP locale détectée : ${serverIp}`);
        } catch (e) {
          console.warn('[WARN] Impossible de détecter l’IP locale, fallback sur localhost');
          serverIp = 'localhost';
        }
      }

      console.log('[DEBUG] Test du serveur avant connexion...');
      fetch(`http://${serverIp}:${serverPort}/health`)
        .then(res => {
          if (res.ok) return res.json();
          throw new Error(`HTTP error ${res.status}`);
        })
        .then(() => {
          attemptWebSocketConnection(serverIp, serverPort);
          sendResponse({ success: true });
        })
        .catch(err => {
          console.error('[ERREUR] Connexion au serveur échouée:', err);
          isConnected = false;
          chrome.storage.local.set({ isConnected: false });
          sendResponse({ success: false, error: 'Failed to connect: ' + err.message });
        });
      return true;

    case 'DISCONNECT':
      cleanupConnection();
      chrome.storage.local.set({ isConnected: false }, async () => {
        await updateExtensionIcon(false);
        sendResponse({ success: true });
      });
      return true;

    case 'GET_HISTORY':
      chrome.storage.local.get(['clipboardHistory'], (result) => {
        clipboardHistory = result.clipboardHistory || [];
        sendResponse({ history: clipboardHistory });
      });
      return true;

    case 'GET_SERVER_HISTORY':
      if (isConnected && socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'get_history' }));
        chrome.storage.local.get(['clipboardHistory'], (result) => {
          sendResponse({ history: result.clipboardHistory || [] });
        });
      } else {
        chrome.storage.local.get(['clipboardHistory'], (result) => {
          sendResponse({ history: result.clipboardHistory || [] });
        });
      }
      return true;

    case 'COPY_TO_CLIPBOARD':
      navigator.clipboard.writeText(request.content)
        .then(() => sendResponse({ success: true }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
  }
  return true;
});

function sendClientInfo() {
  if (socket && socket.readyState === WebSocket.OPEN) {
    chrome.storage.local.get(['localHostname'], (result) => {
      const hostname = result.localHostname || 'Local';
      socket.send(JSON.stringify({
        type: 'client_identify',
        machine_id: localMachineId,
        hostname,
        user_agent: navigator.userAgent
      }));
    });
  }
}