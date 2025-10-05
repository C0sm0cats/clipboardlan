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
    statusElement.innerHTML = `<span class="status-indicator ${success ? 'connected' : 'disconnected'}"></span> ${message}`;
    connectBtn.textContent = success ? 'Disconnect' : 'Connect';
    isConnected = success;

    const displayValue = success ? 'none' : 'block';
    serverIpInput.style.display = displayValue;
    serverPortInput.style.display = displayValue;

    document.querySelectorAll('label').forEach(label => {
      if (label.getAttribute('for') === 'serverIp' || label.getAttribute('for') === 'serverPort') {
        label.style.display = displayValue;
      }
    });

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

    const sortedHistory = [...history].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    const recentItems = sortedHistory.slice(0, 3);

    recentItems.forEach(item => {
      const itemDiv = document.createElement('div');
      itemDiv.className = 'history-item';
      itemDiv.innerHTML = `
        <div class="history-meta">
          <span>${new Date(item.timestamp).toLocaleString()}</span>
          ${item.source ? `<span class="source-badge ${item.source}">${item.source}</span>` : ''}
        </div>
        <div class="history-content-text" title="${escapeHtml(item.content)}">
          ${truncateText(escapeHtml(item.content))}
        </div>
        <div class="history-actions">
          <button class="copy-btn" data-content="${escapeHtml(item.content)}">Copy</button>
        </div>
      `;

      itemDiv.querySelector('.copy-btn').addEventListener('click', async (e) => {
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

      historyDiv.appendChild(itemDiv);
    });
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function loadHistory() {
    chrome.runtime.sendMessage({ type: 'GET_HISTORY' }, response => {
      if (response && response.history) {
        updateHistory(response.history);
      }
    });
  }

  async function checkConnectionStatus() {
    return new Promise((resolve, reject) => {
      console.log('Checking connection status...');
      chrome.runtime.sendMessage({ type: 'GET_CONNECTION_STATUS' }, response => {
        console.log('Received connection status:', response);
        if (chrome.runtime.lastError) {
          console.error('Error getting connection status:', chrome.runtime.lastError);
          reject(chrome.runtime.lastError);
        } else {
          resolve(response || { connected: false });
        }
      });
    });
  }

  async function init() {
    console.log('Initializing popup...');
    try {
      // Load saved state
      const savedState = await new Promise(resolve => {
        chrome.storage.local.get(['isConnected', 'serverIp', 'serverPort'], resolve);
      });
      console.log('Saved state from storage:', savedState);

      // Populate input fields
      serverIpInput.value = savedState.serverIp || '';
      serverPortInput.value = savedState.serverPort || '';

      // Get real-time connection status
      const connectionStatus = await checkConnectionStatus();
      console.log('Real-time connection status:', connectionStatus);

      // Update isConnected based on both storage and real-time status
      isConnected = savedState.isConnected === true && connectionStatus.connected;
      console.log('Determined isConnected:', isConnected);

      // Sync storage with actual connection status
      await chrome.storage.local.set({ isConnected });

      // Update UI with server info when connected
      if (isConnected) {
        updateStatus(`Connected to ${savedState.serverIp || 'server'}:${savedState.serverPort || '8765'}`, true);
      } else {
        updateStatus('Enter Server IP & Port, then click Connect', false);
      }

      // Load history
      loadHistory();
    } catch (error) {
      console.error('Error during initialization:', error);
      isConnected = false;
      await chrome.storage.local.set({ isConnected: false });
      updateStatus('Error initializing', false);
    }
  }

  async function toggleConnection() {
    const serverIp = serverIpInput.value.trim() || '127.0.0.1';
    const serverPort = serverPortInput.value.trim() || '8765';

    await chrome.storage.local.set({ serverIp, serverPort });

    if (isConnected) {
      try {
        await new Promise(resolve => {
          chrome.runtime.sendMessage({ type: 'DISCONNECT' }, response => {
            console.log('Disconnect response:', response);
            resolve(response);
          });
        });
        isConnected = false;
        await chrome.storage.local.set({ isConnected: false });
        updateStatus('Disconnected - Ready for new connection', false);
      } catch (error) {
        console.error('Error disconnecting:', error);
        updateStatus('Error disconnecting', false);
      }
    } else {
      updateStatus('Connecting to server...', false);
      try {
        const response = await new Promise((resolve) => {
          chrome.runtime.sendMessage(
            { type: 'CONNECT', ip: serverIp, port: serverPort },
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
        
        console.log('Connect response:', response);

        if (response && response.success) {
          isConnected = true;
          await chrome.storage.local.set({ isConnected: true, serverIp, serverPort });
          updateStatus(`Connected to ${serverIp}:${serverPort}`, true);
        } else {
          isConnected = false;
          await chrome.storage.local.set({ isConnected: false });
          throw new Error(response?.error || `Failed to connect to ${serverIp}:${serverPort}`);
        }
      } catch (error) {
        console.error('Connection error:', error);
        isConnected = false;
        await chrome.storage.local.set({ isConnected: false });
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

  connectBtn.addEventListener('click', toggleConnection);

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

  // Start initialization
  await init();
  console.log('Popup initialized');
});