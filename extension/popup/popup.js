console.log('Initializing popup...');

document.addEventListener('DOMContentLoaded', async () => {
  console.log('Popup DOM loaded');
  const statusElement = document.getElementById('status');
  const serverIpInput = document.getElementById('serverIp');
  const serverPortInput = document.getElementById('serverPort');
  const connectBtn = document.getElementById('connectBtn');
  const historyDiv = document.getElementById('history');
  let isConnected = false;

  // Update UI based on connection state
  async function updateStatus(message, success) {
    console.log(`Updating status: ${message} (${success ? 'connected' : 'disconnected'})`);
    statusElement.innerHTML = message;
    statusElement.className = `status-badge ${success ? 'connected' : 'disconnected'}`;
    isConnected = success;

    const formDisplay = success ? 'none' : 'flex';
    const disconnectBtn = document.getElementById('disconnectBtn');
    
    serverIpInput.closest('.form-row').style.display = formDisplay;
    serverPortInput.closest('.form-row').style.display = formDisplay;
    connectBtn.style.display = success ? 'none' : 'flex';
    
    if (disconnectBtn) {
      disconnectBtn.style.display = success ? 'flex' : 'none';
    }

    await chrome.storage.local.set({ isConnected: success });
  }

  function truncateText(text, maxLength = 100) {
    if (!text) return '';
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + '...';
  }

  function updateHistory(history) {
    console.log('Updating history in popup:', history);
    historyDiv.innerHTML = '';

    if (!history || history.length === 0) {
      historyDiv.innerHTML = '<div class="empty-state">No clipboard history available</div>';
      return;
    }

    // Deduplicate history based on content only
    const uniqueHistory = [];
    const seenContent = new Set();
    for (const item of history) {
      if (!seenContent.has(item.content)) {
        seenContent.add(item.content);
        uniqueHistory.push(item);
      }
    }

    const sortedHistory = uniqueHistory.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    const recentItems = sortedHistory.slice(0, 3);

    chrome.storage.local.get(['localMachineId', 'localHostname'], function(result) {
      const localMachineId = result.localMachineId || '';
      let localHostname = result.localHostname || 'Local';
      
      if (!result.localHostname) {
        fetch('http://localhost:24900/hostname')
          .then(response => response.ok ? response.json() : {})
          .then(data => {
            const newHostname = data.hostname || 'Local';
            chrome.storage.local.set({ localHostname: newHostname });
            updateHistory(uniqueHistory);
          })
          .catch(console.error);
      }

      recentItems.forEach(item => {
        const itemDiv = document.createElement('div');
        itemDiv.className = 'history-item';
        
        const isLocal = item.machine_id === localMachineId || item.source === 'local';
        let displayName = isLocal ? localHostname : (item.hostname || `Machine: ${item.machine_id ? item.machine_id.substring(0, 8) : 'Inconnue'}`);
        
        displayName = displayName || 'Local';
        
        itemDiv.innerHTML = `
          <div class="history-meta">
            <span>${new Date(item.timestamp).toLocaleString()}</span>
            <span class="source-badge local" title="${isLocal ? 'Local' : 'Distant'}">
              ${displayName}
            </span>
          </div>
          <div class="history-content-text" title="${escapeHtml(item.content)}">
            ${truncateText(escapeHtml(item.content))}
          </div>
          <div class="history-actions">
            <button class="copy-btn" data-content="${escapeHtml(item.content)}">Copy</button>
          </div>
        `;
        
        const copyBtn = itemDiv.querySelector('.copy-btn');
        if (copyBtn) {
          copyBtn.addEventListener('click', async (e) => {
            const content = e.target.getAttribute('data-content');
            try {
              await navigator.clipboard.writeText(content);
              const originalText = e.target.textContent;
              e.target.textContent = 'Copied!';
              e.target.style.backgroundColor = '#28a745';
              setTimeout(() => {
                if (e.target) {
                  e.target.textContent = originalText;
                  e.target.style.backgroundColor = '';
                }
              }, 1500);
            } catch (error) {
              console.error('Failed to copy text:', error);
              updateStatus('Error copying to clipboard', false);
            }
          });
        }
        
        historyDiv.appendChild(itemDiv);
      });
    });
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  async function loadHistory() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'GET_SERVER_HISTORY' }, response => {
        if (response && response.history) {
          updateHistory(response.history);
          chrome.storage.local.set({ clipboardHistory: response.history });
          resolve(response.history);
        } else {
          console.error('Failed to load server history:', response);
          chrome.storage.local.get(['clipboardHistory'], (result) => {
            const localHistory = result.clipboardHistory || [];
            updateHistory(localHistory);
            resolve(localHistory);
          });
        }
      });
    });
  }

  async function checkConnectionStatus() {
    return new Promise((resolve) => {
      console.log('Checking connection status...');
      
      chrome.storage.local.get(['isConnected', 'serverIp', 'serverPort', 'lastConnection'], (savedState) => {
        console.log('Saved connection state:', savedState);
        
        const isRecentlyConnected = savedState.lastConnection && 
          (Date.now() - new Date(savedState.lastConnection).getTime() < 5 * 60 * 1000);
        
        chrome.runtime.sendMessage({ type: 'GET_CONNECTION_STATUS' }, (response) => {
          if (chrome.runtime.lastError) {
            console.error('Error getting connection status:', chrome.runtime.lastError);
            resolve({
              connected: savedState.isConnected === true && isRecentlyConnected,
              serverIp: savedState.serverIp,
              serverPort: savedState.serverPort,
              fromCache: true
            });
          } else {
            const isConnected = (response && response.connected) || false;
            if (isConnected) {
              chrome.storage.local.set({
                isConnected: true,
                lastConnection: new Date().toISOString()
              });
            }
            
            resolve({
              connected: isConnected || (savedState.isConnected && isRecentlyConnected),
              serverIp: savedState.serverIp,
              serverPort: savedState.serverPort,
              fromCache: !isConnected && savedState.isConnected && isRecentlyConnected
            });
          }
        });
      });
    });
  }

  async function init() {
    console.log('Initializing popup...');
    try {
      const savedState = await new Promise(resolve => {
        chrome.storage.local.get(['isConnected', 'serverIp', 'serverPort', 'localMachineId'], resolve);
      });
      console.log('Saved state from storage:', savedState);

      serverIpInput.value = savedState.serverIp || '';
      serverPortInput.value = savedState.serverPort || '';

      if (!savedState.localMachineId) {
        const newMachineId = 'browser_' + Math.random().toString(36).substr(2, 9);
        await chrome.storage.local.set({ localMachineId: newMachineId });
        console.log('[DEBUG] New local machine ID generated:', newMachineId);
      }

      const connectionStatus = await checkConnectionStatus();
      console.log('Real-time connection status:', connectionStatus);
      
      if (connectionStatus.connected) {
        const ip = savedState.serverIp || 'server';
        const port = savedState.serverPort || '';
        const serverInfo = `Connected to ${ip}${port ? ':' + port : ''}`;
        updateStatus(serverInfo, true);
      } else {
        // Do not attempt auto-reconnect; show disconnected state
        updateStatus('<span style="color: var(--text-color)">Enter Server IP & Port, then click Connect</span>', false);
      }

      await loadHistory();
      
    } catch (error) {
      console.error('Error during initialization:', error);
      isConnected = false;
      await chrome.storage.local.set({ isConnected: false });
      updateStatus('Error initializing', false);
    }
  }

  async function toggleConnection() {
    const serverIp = serverIpInput.value.trim() || '0.0.0.0';
    const serverPort = serverPortInput.value.trim() || '24900';
    const now = new Date().toISOString();

    if (isConnected) {
      try {
        updateStatus('Disconnecting...', false);
        
        const response = await new Promise((resolve) => {
          chrome.runtime.sendMessage(
            { type: 'DISCONNECT' },
            (response) => {
              if (chrome.runtime.lastError) {
                console.error('Disconnect error:', chrome.runtime.lastError);
                resolve({ success: false, error: chrome.runtime.lastError.message });
              } else {
                resolve(response || { success: false, error: 'No response from background script' });
              }
            }
          );
        });

        if (response && response.success) {
          await chrome.storage.local.set({
            isConnected: false,
            lastDisconnection: now,
            serverIp,
            serverPort
          });
          isConnected = false;
          updateStatus('Disconnected - Ready for new connection', false);
        } else {
          throw new Error(response?.error || 'Failed to disconnect');
        }
      } catch (error) {
        console.error('Error disconnecting:', error);
        updateStatus(`Error disconnecting: ${error.message}`, false);
        await chrome.storage.local.set({
          isConnected: false,
          lastDisconnection: now
        });
      }
    } else {
      updateStatus('Connecting to server...', false);
      
      try {
        await chrome.storage.local.set({
          serverIp,
          serverPort,
          lastConnectionAttempt: now
        });

        const response = await new Promise((resolve) => {
          chrome.runtime.sendMessage(
            { 
              type: 'CONNECT', 
              ip: serverIp, 
              port: serverPort 
            },
            (response) => {
              if (chrome.runtime.lastError) {
                console.error('Connection error:', chrome.runtime.lastError);
                resolve({ success: false, error: chrome.runtime.lastError.message });
              } else {
                resolve(response || { success: false, error: 'No response from background script' });
              }
            }
          );
        });

        if (response && response.success) {
          await chrome.storage.local.set({
            isConnected: true,
            lastConnection: now,
            serverIp,
            serverPort
          });
          isConnected = true;
          updateStatus(`Connected to ${serverIp}:${serverPort}`, true);
          console.log('Successfully connected to server');
          await loadHistory();
        } else {
          throw new Error(response?.error || `Failed to connect to ${serverIp}:${serverPort}`);
        }
      } catch (error) {
        console.error('Connection error:', error);
        isConnected = false;
        await chrome.storage.local.set({ 
          isConnected: false,
          lastConnectionError: now,
          lastError: error.message
        });
        updateStatus(`Error: ${error.message}`, false);
      }
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    console.log('Popup received message:', message);
    if (message.type === 'clipboard_update' && message.history) {
      updateHistory(message.history);
    } else if (message.type === 'STATUS_UPDATE') {
      isConnected = message.success;
      updateStatus(message.message, message.success);
    }
  });

  init();

  connectBtn.addEventListener('click', toggleConnection);
  document.getElementById('disconnectBtn')?.addEventListener('click', toggleConnection);
  
  setInterval(async () => {
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        const text = await navigator.clipboard.readText();
        if (text && text.trim() !== '') {
          chrome.runtime.sendMessage({ type: 'CLIPBOARD_CHANGE', content: text });
        }
      }
    } catch (error) {
      console.error('Error checking clipboard:', error);
    }
  }, 2000);

  if (navigator.clipboard && navigator.clipboard.readText) {
    navigator.clipboard.readText().then(text => {
      if (text && text.trim() !== '') {
        chrome.runtime.sendMessage({ type: 'CLIPBOARD_CHANGE', content: text });
      }
    }).catch(console.error);
  }

  console.log('Popup initialized');
});