console.log('Background script loaded');

const MAX_HISTORY = 3;
let clipboardHistory = [];
let lastClipboardContent = '';
let socket = null;
let isConnected = false;

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
            console.log('Historique mis à jour:', clipboardHistory);
          });
          try {
            chrome.runtime.sendMessage({
              type: 'clipboard_update',
              history: clipboardHistory
            }).catch(error => {
              if (error.message !== 'Could not establish connection. Receiving end does not exist.') {
                console.error('Erreur lors de l\'envoi de la mise à jour au popup:', error);
              }
            });
          } catch (e) {
            console.error('Erreur lors de l\'envoi de la mise à jour au popup:', e);
          }
          if (isConnected && socket && socket.readyState === WebSocket.OPEN) {
            try {
              socket.send(JSON.stringify({
                type: 'clipboard_update',
                content: content,
                timestamp: timestamp,
                source: 'local'
              }));
            } catch (e) {
              console.error('Erreur lors de l\'envoi au serveur:', e);
            }
          }
        }
      }
    }
  }
}

let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
let reconnectTimeout = null;
let lastPingTime = 0;
const PING_INTERVAL = 25000;
let pingInterval = null;

function updateConnectionStatus(connected, message = '') {
  console.log(`Updating connection status: ${connected} (${message})`);
  isConnected = connected;
  if (!connected) {
    if (pingInterval) {
      clearInterval(pingInterval);
      pingInterval = null;
    }
  }
  
  // Toujours essayer d'utiliser les informations de connexion les plus récentes
  chrome.storage.local.get(['serverIp', 'serverPort'], (result) => {
    let statusMessage = message;
    
    // Si pas de message personnalisé, en créer un
    if (!statusMessage) {
      statusMessage = connected ? 'Connected to server' : 'Disconnected from server';
    }
    
    // Si connecté et qu'on a des infos de connexion, les ajouter au message
    if (connected && result.serverIp && result.serverPort) {
      // Si le message ne contient pas déjà l'IP et le port, les ajouter
      if (!statusMessage.includes(result.serverIp) || !statusMessage.includes(result.serverPort)) {
        statusMessage = `Connected to ${result.serverIp}:${result.serverPort}`;
      }
    }
    
    // Envoyer la mise à jour avec le message final
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
      console.error('Error sending STATUS_UPDATE:', error);
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
      } catch (e) {
        console.error('❌ Erreur lors de l\'envoi du ping:', e);
        updateConnectionStatus(false, 'Ping failed');
      }
    }
  }, PING_INTERVAL);
}

function attemptWebSocketConnection(serverIp, serverPort) {
  if (socket) {
    socket.close();
    socket = null;
  }

  // Sauvegarder les informations de connexion avant d'établir la connexion
  chrome.storage.local.set({ serverIp, serverPort }, () => {
    console.log('🔑 Informations de connexion sauvegardées:', { serverIp, serverPort });
  });

  const wsUrl = `ws://${serverIp}:${serverPort}/ws`;
  console.log('🔗 Tentative de connexion WebSocket vers:', wsUrl);

  try {
    socket = new WebSocket(wsUrl);
    reconnectAttempts = 0;

    const connectionTimeout = setTimeout(() => {
      if (socket && socket.readyState === WebSocket.CONNECTING) {
        console.error('⏰ Délai de connexion WebSocket dépassé');
        socket.close();
        updateConnectionStatus(false, 'Connection timeout');
        handleReconnection(serverIp, serverPort);
      }
    }, 10000);

    socket.onopen = () => {
      clearTimeout(connectionTimeout);
      console.log('✅ Connexion WebSocket établie avec succès');
      setupPing();
      
      // Mettre à jour le statut avec les informations de connexion actuelles
      // On utilise directement les variables serverIp et serverPort qui viennent d'être utilisées pour la connexion
      const statusMessage = `Connected to ${serverIp}:${serverPort}`;
      updateConnectionStatus(true, statusMessage);
      
      // Sauvegarder l'état de connexion
      chrome.storage.local.set({ isConnected: true });
      
      if (socket.readyState === WebSocket.OPEN) {
        try {
          socket.send(JSON.stringify({ type: 'get_history' }));
        } catch (e) {
          console.error('❌ Erreur lors de la demande d\'historique:', e);
        }
      }
    };

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        console.log('📨 Message reçu du serveur:', data);

        if (data.type === 'ping') {
          socket.send(JSON.stringify({ type: 'pong', timestamp: data.timestamp }));
          return;
        }

        if (data.type === 'clipboard_update') {
          console.log('📋 Mise à jour du presse-papier reçue:', data.history?.length || 0, 'éléments');
          if (data.history && Array.isArray(data.history)) {
            data.history.forEach(item => {
              updateHistory(item.content, 'server');
            });
          }
          chrome.runtime.sendMessage(data).catch(error => {
            if (error.message !== 'Could not establish connection. Receiving end does not exist.') {
              console.error('Error sending clipboard_update:', error);
            }
          });
        } else if (data.type === 'heartbeat') {
          console.log('💓 Heartbeat reçu du serveur:', data.message);
          socket.send(JSON.stringify({
            type: 'heartbeat_response',
            timestamp: new Date().toISOString(),
            message: 'Client is alive'
          }));
        } else {
          console.log('📨 Autre type de message:', data.type);
        }
      } catch (e) {
        console.error('❌ Erreur lors du traitement du message:', e);
      }
    };

    socket.onclose = (event) => {
      console.log('❌ Connexion WebSocket fermée:', event.code, event.reason);
      isConnected = false;
      clearTimeout(connectionTimeout);
      if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
      }
      if (event.code !== 1000) {
        handleReconnection(serverIp, serverPort);
      } else {
        updateConnectionStatus(false, 'Disconnected from server');
      }
    };

    socket.onerror = (error) => {
      console.error('❌ Erreur WebSocket:', error);
      clearTimeout(connectionTimeout);
      isConnected = false;
      if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
      }
      updateConnectionStatus(false, 'Connection error: ' + (error.message || 'Unknown error'));
      handleReconnection(serverIp, serverPort);
    };
  } catch (e) {
    console.error('❌ Erreur lors de la création de la connexion WebSocket:', e);
    updateConnectionStatus(false, 'Connection failed: ' + (e.message || 'Unknown error'));
    handleReconnection(serverIp, serverPort);
  }
}

function handleReconnection(serverIp, serverPort) {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    const errorMessage = `Failed to connect to ${serverIp}:${serverPort} after ${MAX_RECONNECT_ATTEMPTS} attempts`;
    console.error(`❌ ${errorMessage}`);
    updateConnectionStatus(false, errorMessage);
    return;
  }

  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
  console.log(`⏳ Tentative de reconnexion dans ${delay/1000} secondes... (${reconnectAttempts + 1}/${MAX_RECONNECT_ATTEMPTS})`);
  
  // Mettre à jour le statut avec les infos de connexion
  const statusMessage = `Reconnecting to ${serverIp}:${serverPort}...`;
  updateConnectionStatus(false, statusMessage);
  
  reconnectTimeout = setTimeout(() => {
    attemptWebSocketConnection(serverIp, serverPort);
  }, delay);
  
  reconnectAttempts++;
}

chrome.runtime.onSuspend.addListener(() => {
  console.log('🔌 Nettoyage des connexions avant la suspension...');
  cleanupConnection();
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('Background received message:', request);

  switch (request.type) {
    case 'CLIPBOARD_CHANGE':
      if (request.content) {
        console.log('Mise à jour du presse-papiers reçue:', request.content);
        updateHistory(request.content, 'local');
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: 'Aucun contenu fourni' });
      }
      return true;

    case 'GET_CONNECTION_STATUS':
      console.log('GET_CONNECTION_STATUS requested, current state:', {
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
      console.log('🔍 Testing server connectivity first...');
      fetch(`http://${serverIp}:${serverPort}/health`)
        .then(response => {
          if (response.ok) {
            console.log('✅ HTTP server is responding');
            return response.json();
          }
          throw new Error(`HTTP error ${response.status}`);
        })
        .then(data => {
          console.log('Server status:', data);
          attemptWebSocketConnection(serverIp, serverPort);
          sendResponse({ success: true });
        })
        .catch(error => {
          console.error('❌ Failed to connect to server:', error);
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
      chrome.storage.local.set({ isConnected: false });
      sendResponse({ success: true });
      break;

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
          console.error('Erreur lors de l\'écriture dans le clipboard:', error);
          sendResponse({ success: false, error: error.message });
        });
      return true;

    default:
      console.warn('Unknown message type:', request.type);
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
      console.warn('Clipboard API not available in this context');
    }
  } catch (error) {
    console.error('Erreur lors de la lecture du clipboard:', error);
  }
}