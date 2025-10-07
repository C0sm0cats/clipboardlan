console.log('Background script loaded');

const MAX_HISTORY = 3;
const MAX_RECONNECT_ATTEMPTS = 5; // Define missing constant
let clipboardHistory = [];
let lastClipboardContent = '';
let socket = null;
let isConnected = false;
let reconnectAttempts = 0;
let reconnectTimeout = null;
const PING_INTERVAL = 25000;
let pingInterval = null;
let machineId = ''; // Stocke l'ID de la machine attribué par le serveur
let localMachineId = ''; // ID local pour cette instance du navigateur

function updateHistory(content, source = 'local', machineId = '') {
  if (content && content.trim() !== '') {
    const timestamp = new Date().toISOString();
    const newItem = { 
      content, 
      timestamp, 
      source,
      machine_id: machineId || localMachineId
    };

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
        
        // Envoyer la mise à jour au serveur si on est connecté
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
    // Sauvegarder l'état de connexion dans le stockage local
    await chrome.storage.local.set({ isConnected: connected });
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
    
    // Mettre à jour les informations de connexion dans le stockage local
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

// Configuration des paramètres de connexion
const WS_RECONNECT_BASE_DELAY = 1000; // 1 seconde de base
const WS_MAX_RECONNECT_ATTEMPTS = 10;
const WS_PING_INTERVAL = 25000; // 25 secondes (moins que le timeout du serveur)
const WS_CONNECTION_TIMEOUT = 10000; // 10 secondes de timeout de connexion

function calculateReconnectDelay(attempt) {
  // Backoff exponentiel avec un délai maximum de 30 secondes
  return Math.min(WS_RECONNECT_BASE_DELAY * Math.pow(2, attempt), 30000);
}

function attemptWebSocketConnection(serverIp, serverPort) {
  // Annuler toute tentative de reconnexion en cours
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }

  // Fermer la connexion existante si elle existe
  if (socket) {
    try {
      socket.close();
    } catch (e) {
      console.warn('[WS] Erreur lors de la fermeture de la connexion existante:', e);
    }
    socket = null;
  }

  // Sauvegarder les informations de connexion
  chrome.storage.local.set({ serverIp, serverPort }, () => {
    console.log('[WS] Informations de connexion sauvegardées:', { serverIp, serverPort });
  });

  const wsUrl = `ws://${serverIp}:${serverPort}/ws`;
  console.log(`[WS] Tentative de connexion (${reconnectAttempts + 1}/${WS_MAX_RECONNECT_ATTEMPTS}):`, wsUrl);

  try {
    socket = new WebSocket(wsUrl);
    
    // Configurer le timeout de connexion
    const connectionTimeout = setTimeout(() => {
      if (socket && socket.readyState === WebSocket.CONNECTING) {
        console.error('[WS] Délai de connexion WebSocket dépassé (10s)');
        socket.close();
        handleReconnection(serverIp, serverPort);
      }
    }, WS_CONNECTION_TIMEOUT);

    socket.onopen = () => {
      clearTimeout(connectionTimeout);
      console.log('[WS] Connexion WebSocket établie avec succès');
      isConnected = true;
      reconnectAttempts = 0; // Réinitialiser le compteur de reconnexion
      updateConnectionStatus(true, 'Connecté au serveur');
      
      // Démarrer le ping
      if (pingInterval) clearInterval(pingInterval);
      pingInterval = setInterval(() => {
        if (socket && socket.readyState === WebSocket.OPEN) {
          try {
            socket.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
          } catch (e) {
            console.error('[WS] Erreur lors de l\'envoi du ping:', e);
          }
        }
      }, WS_PING_INTERVAL);
      
      // Envoyer les informations du client
      sendClientInfo();
    };

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        console.log('[WS] Message reçu:', data);
        
        // Traiter les différents types de messages
        if (data.type === 'pong') {
          // Mettre à jour le timestamp du dernier pong
          lastPongTime = Date.now();
        } else if (data.type === 'clipboard_update') {
          // Vérifier si le message vient d'une autre machine
          const isFromOtherMachine = data.machine_id && data.machine_id !== localMachineId;
          
          if (isFromOtherMachine) {
            console.log(`[DEBUG] Mise à jour reçue d'une autre machine (${data.machine_id})`);
            // Mettre à jour l'historique avec l'ID de la machine source
            updateHistory(data.content, 'remote', data.machine_id);
          }
        } else if (data.type === 'client_id' && data.client_id) {
          machineId = data.client_id;
          console.log('[DEBUG] ID de machine reçu du serveur:', machineId);
        }
      } catch (e) {
        console.error('[WS] Erreur lors du traitement du message:', e);
      }
    };

    socket.onclose = (event) => {
      clearTimeout(connectionTimeout);
      console.log(`[WS] Connexion fermée (code: ${event.code}, raison: ${event.reason || 'inconnue'})`);
      isConnected = false;
      
      // Nettoyer
      if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
      }
      
      // Tenter de se reconnecter si ce n'est pas une fermeture normale
      if (event.code !== 1000) { // 1000 = fermeture normale
        handleReconnection(serverIp, serverPort);
      } else {
        updateConnectionStatus(false, 'Déconnecté');
      }
    };
    
    socket.onerror = (error) => {
      clearTimeout(connectionTimeout);
      console.error('[WS] Erreur WebSocket:', error);
      isConnected = false;
      updateConnectionStatus(false, 'Erreur de connexion');
      
      // Tenter de se reconnecter
      handleReconnection(serverIp, serverPort);
    };
  } catch (e) {
    console.error('[ERREUR] Erreur lors de la création de la connexion WebSocket:', e);
    updateConnectionStatus(false, 'Connection failed: ' + (e.message || 'Unknown error'));
    handleReconnection(serverIp, serverPort);
  }
  
  // Vérifier si on doit se reconnecter automatiquement
  chrome.storage.local.get(['isConnected', 'serverIp', 'serverPort'], (result) => {
    if (result.isConnected && result.serverIp && result.serverPort) {
      console.log('[DEBUG] Tentative de reconnexion automatique au serveur...');
      attemptWebSocketConnection(result.serverIp, result.serverPort);
    }
  });
}

function handleReconnection(serverIp, serverPort) {
  if (reconnectAttempts >= WS_MAX_RECONNECT_ATTEMPTS) {
    const errorMessage = `Failed to connect to ${serverIp}:${serverPort} after ${WS_MAX_RECONNECT_ATTEMPTS} attempts`;
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

// La fonction checkClipboard n'est plus nécessaire ici car la détection est gérée par le content script
function checkClipboard() {
  // Cette fonction est maintenue pour la rétrocompatibilité
  // mais ne fait plus rien car la détection est gérée par le content script
}

// Écouter les messages du content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('[DEBUG] Message reçu du content script:', { type: request.type, from: sender.url });
  
  if (request.type === 'CLIPBOARD_CHANGE') {
    console.log('📋 [CLIPBOARD_CHANGE] Contenu reçu:', 
      request.content ? request.content.substring(0, 50) + (request.content.length > 50 ? '...' : '') : 'vide',
      `(longueur: ${request.content?.length || 0} caractères)`
    );
    
    // Mettre à jour l'historique local
    updateHistory(request.content, 'local');
    
    // Envoyer la mise à jour au serveur
    if (isConnected && socket && socket.readyState === WebSocket.OPEN) {
      try {
        const message = {
          type: 'clipboard_update',
          content: request.content,
          timestamp: new Date().toISOString(),
          source: 'local',
          machine_id: localMachineId,
          url: request.url || 'unknown'
        };
        
        console.log('📤 Envoi au serveur:', { 
          type: message.type,
          content_length: message.content?.length || 0,
          machine_id: message.machine_id
        });
        
        socket.send(JSON.stringify(message));
      } catch (e) {
        console.error('❌ Erreur lors de l\'envoi au serveur:', e);
      }
    } else {
      console.warn('⚠️ Non connecté au serveur. Impossible d\'envoyer la mise à jour.');
    }
  }
  
  return true; // Garder le canal de messagerie ouvert pour les réponses asynchrones
});

// Fonction pour envoyer les informations du client
function sendClientInfo() {
  if (socket && socket.readyState === WebSocket.OPEN) {
    chrome.storage.local.get(['localHostname'], (result) => {
      const hostname = result.localHostname || 'Local';
      socket.send(JSON.stringify({
        type: 'client_identify',
        machine_id: localMachineId,
        hostname: hostname,
        user_agent: navigator.userAgent
      }));
    });
  }
}