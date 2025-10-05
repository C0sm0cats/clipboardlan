console.log('Background script loaded');

const MAX_HISTORY = 3;
const MAX_RECONNECT_ATTEMPTS = 5; // Define missing constant
let clipboardHistory = [];
let lastClipboardContent = '';
let socket = null;
let isConnected = false;
let reconnectAttempts = 0;
let reconnectTimeout = null;
let lastPingTime = 0;
const PING_INTERVAL = 25000;
let pingInterval = null;

function updateHistory(content, source = 'local') {
  if (content && content.trim() !== '') {
    const timestamp = new Date().toISOString();
    const newItem = { content, timestamp, source };

    if (source === 'local') {
      if (clipboardHistory.length === 0 || clipboardHistory[0].content !== content) {
        const exists = clipboardHistory.some(item => item.content === content);
        if (!exists) {
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
                source: 'local'
              }));
              console.log('[DEBUG] Mise à jour envoyée au serveur:', content);
            } catch (e) {
              console.error('[ERREUR] Erreur lors de l\'envoi au serveur:', e);
            }
          }
        }
      }
    }
  }
}

async function updateExtensionIcon(connected) {
  console.log(`[DEBUG] Mise à jour de l'icône - Statut: ${connected ? 'Connecté' : 'Déconnecté'}`);
  const statusText = connected ? 'ON' : 'OFF';
  const title = connected ? 'ClipboardLan: Connecté' : 'ClipboardLan: Déconnecté';
  const color = connected ? '#4CAF50' : '#F44336';

  try {
    // Clear badge first to force visual refresh
    await chrome.action.setBadgeText({ text: '' });
    console.log('[DEBUG] Badge text cleared');
    await chrome.action.setBadgeText({ text: statusText });
    console.log(`[DEBUG] Badge text set to: ${statusText}`);
    await chrome.action.setBadgeBackgroundColor({ color });
    console.log(`[DEBUG] Badge background color set to: ${color}`);
    await chrome.action.setBadgeTextColor({ color: '#FFFFFF' });
    console.log(`[DEBUG] Badge text color set to: #FFFFFF`);
    await chrome.action.setTitle({ title });
    console.log(`[DEBUG] Badge title set to: ${title}`);
    console.log(`[SUCCÈS] Badge mis à jour: ${statusText}`);
  } catch (error) {
    console.error(`[ERREUR] Échec de la mise à jour du badge: ${error.message}`);
    // Retry after a short delay
    setTimeout(async () => {
      try {
        await chrome.action.setBadgeText({ text: '' });
        await chrome.action.setBadgeText({ text: statusText });
        await chrome.action.setBadgeBackgroundColor({ color });
        await chrome.action.setBadgeTextColor({ color: '#FFFFFF' });
        await chrome.action.setTitle({ title });
        console.log('[SUCCÈS] Deuxième tentative de mise à jour réussie');
      } catch (retryError) {
        console.error('[ERREUR] Échec de la deuxième tentative de mise à jour:', retryError);
      }
    }, 300);
  }
  return Promise.resolve();
}

async function updateConnectionStatus(connected, message = '') {
  console.log(`[DEBUG] updateConnectionStatus - Ancien statut: ${isConnected}, Nouveau statut: ${connected}, Message: ${message}`);
  const wasConnected = isConnected;
  isConnected = connected;

  try {
    await updateExtensionIcon(connected);
    console.log('[SUCCÈS] Mise à jour du statut terminée');
  } catch (error) {
    console.error('[ERREUR] Échec de la mise à jour du statut:', error);
  }

  if (!connected) {
    if (pingInterval) {
      clearInterval(pingInterval);
      pingInterval = null;
      console.log('[DEBUG] Ping interval cleared');
    }
  }

  chrome.storage.local.get(['serverIp', 'serverPort'], (result) => {
    let statusMessage = message;
    if (!statusMessage) {
      statusMessage = connected ? 'Connected to server' : 'Disconnected from server';
    }
    if (connected && result.serverIp && result.serverPort) {
      if (!statusMessage.includes(result.serverIp) || !statusMessage.includes(result.serverPort)) {
        statusMessage = `Connected to ${result.serverIp}:${result.serverPort}`;
      }
    }
    sendStatusUpdate(connected, statusMessage);
  });
}

function sendStatusUpdate(connected, message) {
  chrome.runtime.sendMessage({
    type: 'STATUS_UPDATE',
    message: message,
    success: connected
  }).catch(error => {
    if (error.message !== 'Could not establish connection. Receiving end does not exist.') {
      console.error('[ERREUR] Error sending STATUS_UPDATE:', error);
    }
  });
}

function setupPing() {
  if (pingInterval) clearInterval(pingInterval);
  pingInterval = setInterval(() => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
        lastPingTime = Date.now();
        console.log('[DEBUG] Ping sent');
      } catch (e) {
        console.error('[ERREUR] Erreur lors de l\'envoi du ping:', e);
        updateConnectionStatus(false, 'Ping failed');
      }
    }
  }, PING_INTERVAL);
}

function attemptWebSocketConnection(serverIp, serverPort) {
  if (socket) {
    socket.close();
    socket = null;
    console.log('[DEBUG] Previous WebSocket closed');
  }

  chrome.storage.local.set({ serverIp, serverPort }, () => {
    console.log('[DEBUG] Informations de connexion sauvegardées:', { serverIp, serverPort });
  });

  const wsUrl = `ws://${serverIp}:${serverPort}/ws`;
  console.log('[DEBUG] Tentative de connexion WebSocket vers:', wsUrl);

  try {
    socket = new WebSocket(wsUrl);
    reconnectAttempts = 0;

    const connectionTimeout = setTimeout(() => {
      if (socket && socket.readyState === WebSocket.CONNECTING) {
        console.error('[ERREUR] Délai de connexion WebSocket dépassé');
        socket.close();
        updateConnectionStatus(false, 'Connection timeout');
        handleReconnection(serverIp, serverPort);
      }
    }, 10000);

    socket.onopen = () => {
      clearTimeout(connectionTimeout);
      console.log('[SUCCÈS] Connexion WebSocket établie');
      setupPing();
      const statusMessage = `Connected to ${serverIp}:${serverPort}`;
      updateConnectionStatus(true, statusMessage);
      chrome.storage.local.set({ isConnected: true });
      if (socket.readyState === WebSocket.OPEN) {
        try {
          socket.send(JSON.stringify({ type: 'get_history' }));
          console.log('[DEBUG] Demande d\'historique envoyée');
        } catch (e) {
          console.error('[ERREUR] Erreur lors de la demande d\'historique:', e);
        }
      }
    };

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        console.log('[DEBUG] Message reçu du serveur:', data);

        if (data.type === 'ping') {
          socket.send(JSON.stringify({ type: 'pong', timestamp: data.timestamp }));
          console.log('[DEBUG] Pong sent');
          return;
        }

        if (data.type === 'clipboard_update') {
          console.log('[DEBUG] Mise à jour du presse-papier reçue:', data.history?.length || 0, 'éléments');
          if (data.history && Array.isArray(data.history)) {
            data.history.forEach(item => {
              updateHistory(item.content, 'server');
            });
          }
          chrome.runtime.sendMessage(data).catch(error => {
            if (error.message !== 'Could not establish connection. Receiving end does not exist.') {
              console.error('[ERREUR] Error sending clipboard_update:', error);
            }
          });
        } else if (data.type === 'heartbeat') {
          console.log('[DEBUG] Heartbeat reçu du serveur:', data.message);
          socket.send(JSON.stringify({
            type: 'heartbeat_response',
            timestamp: new Date().toISOString(),
            message: 'Client is alive'
          }));
        } else {
          console.log('[DEBUG] Autre type de message:', data.type);
        }
      } catch (e) {
        console.error('[ERREUR] Erreur lors du traitement du message:', e);
      }
    };

    socket.onclose = (event) => {
      console.log('[DEBUG] Connexion WebSocket fermée:', event.code, event.reason);
      isConnected = false;
      clearTimeout(connectionTimeout);
      if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
        console.log('[DEBUG] Ping interval cleared on close');
      }
      if (event.code !== 1000) {
        handleReconnection(serverIp, serverPort);
      } else {
        updateConnectionStatus(false, 'Disconnected from server');
      }
    };

    socket.onerror = (error) => {
      console.error('[ERREUR] Erreur WebSocket:', error);
      clearTimeout(connectionTimeout);
      isConnected = false;
      if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
        console.log('[DEBUG] Ping interval cleared on error');
      }
      updateConnectionStatus(false, 'Connection error: ' + (error.message || 'Unknown error'));
      handleReconnection(serverIp, serverPort);
    };
  } catch (e) {
    console.error('[ERREUR] Erreur lors de la création de la connexion WebSocket:', e);
    updateConnectionStatus(false, 'Connection failed: ' + (e.message || 'Unknown error'));
    handleReconnection(serverIp, serverPort);
  }
}

function handleReconnection(serverIp, serverPort) {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    const errorMessage = `Failed to connect to ${serverIp}:${serverPort} after ${MAX_RECONNECT_ATTEMPTS} attempts`;
    console.error(`[ERREUR] ${errorMessage}`);
    updateConnectionStatus(false, errorMessage);
    return;
  }

  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
  console.log(`[DEBUG] Tentative de reconnexion dans ${delay/1000} secondes... (${reconnectAttempts + 1}/${MAX_RECONNECT_ATTEMPTS})`);
  const statusMessage = `Reconnecting to ${serverIp}:${serverPort}...`;
  updateConnectionStatus(false, statusMessage);
  reconnectTimeout = setTimeout(() => {
    attemptWebSocketConnection(serverIp, serverPort);
  }, delay);
  reconnectAttempts++;
}

function cleanupConnection() {
  console.log('[DEBUG] Nettoyage des connexions');
  if (socket) {
    try {
      socket.close();
      console.log('[DEBUG] WebSocket closed');
    } catch (e) {
      console.error('[ERREUR] Error closing WebSocket:', e);
    }
    socket = null;
  }
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
    console.log('[DEBUG] Ping interval cleared');
  }
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
    console.log('[DEBUG] Reconnect timeout cleared');
  }
  isConnected = false;
  console.log('[DEBUG] isConnected set to false');
}

chrome.runtime.onSuspend.addListener(() => {
  console.log('[DEBUG] Nettoyage des connexions avant la suspension...');
  cleanupConnection();
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('[DEBUG] Background received message:', request);

  switch (request.type) {
    case 'CLIPBOARD_CHANGE':
      if (request.content) {
        console.log('[DEBUG] Mise à jour du presse-papiers reçue:', request.content);
        updateHistory(request.content, 'local');
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: 'Aucun contenu fourni' });
      }
      return true;

    case 'GET_CONNECTION_STATUS':
      console.log('[DEBUG] GET_CONNECTION_STATUS requested, current state:', {
        isConnected,
        socketExists: !!socket,
        socketReadyState: socket ? socket.readyState : 'no socket'
      });
      sendResponse({
        connected: isConnected && socket && socket.readyState === WebSocket.OPEN
      });
      return true;

    case 'CONNECT':
      const serverIp = request.ip || '0.0.0.0';
      const serverPort = request.port || '24900';
      console.log('[DEBUG] Testing server connectivity first...');
      fetch(`http://${serverIp}:${serverPort}/health`)
        .then(response => {
          if (response.ok) {
            console.log('[SUCCÈS] HTTP server is responding');
            return response.json();
          }
          throw new Error(`HTTP error ${response.status}`);
        })
        .then(data => {
          console.log('[DEBUG] Server status:', data);
          attemptWebSocketConnection(serverIp, serverPort);
          sendResponse({ success: true });
        })
        .catch(error => {
          console.error('[ERREUR] Failed to connect to server:', error);
          isConnected = false;
          chrome.storage.local.set({ isConnected: false });
          sendResponse({
            success: false,
            error: 'Failed to connect to server: ' + error.message
          });
        });
      return true;

    case 'DISCONNECT':
      cleanupConnection();
      chrome.storage.local.set({ isConnected: false }, async () => {
        try {
          await updateExtensionIcon(false);
          console.log('[SUCCÈS] Badge updated to OFF state after disconnect');
          sendResponse({ success: true });
        } catch (error) {
          console.error('[ERREUR] Failed to update badge after disconnect:', error);
          sendResponse({ success: false, error: 'Failed to update badge' });
        }
      });
      return true; // Indicate async response

    case 'GET_HISTORY':
      chrome.storage.local.get(['clipboardHistory'], (result) => {
        if (result.clipboardHistory) {
          clipboardHistory = result.clipboardHistory;
        }
        sendResponse({ history: clipboardHistory });
      });
      return true;

    case 'COPY_TO_CLIPBOARD':
      navigator.clipboard.writeText(request.content)
        .then(() => sendResponse({ success: true }))
        .catch(error => {
          console.error('[ERREUR] Erreur lors de l\'écriture dans le clipboard:', error);
          sendResponse({ success: false, error: error.message });
        });
      return true;

    default:
      console.warn('[AVERTISSEMENT] Unknown message type:', request.type);
      sendResponse({ success: false, error: 'Unknown message type' });
  }

  return true;
});

async function checkClipboard() {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.readText) {
      const text = await navigator.clipboard.readText();
      updateHistory(text, 'local');
    } else {
      console.warn('[AVERTISSEMENT] Clipboard API not available in this context');
    }
  } catch (error) {
    console.error('[ERREUR] Erreur lors de la lecture du clipboard:', error);
  }
}