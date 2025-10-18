console.log('Content script chargé sur:', window.location.href);

let lastClipboardContent = '';
let isMonitoring = true;

function sendClipboardUpdate(text) {
  if (!text || text === lastClipboardContent) return;
  lastClipboardContent = text;
  console.log('📋 Nouveau contenu détecté:', text.length > 50 ? text.substring(0, 50) + '...' : text);
  chrome.runtime.sendMessage({
    type: 'CLIPBOARD_CHANGE',
    content: text,
    url: window.location.href,
    timestamp: new Date().toISOString()
  }).catch(err => console.error('❌ Erreur sendMessage:', err));
}

document.addEventListener('copy', async () => {
  try {
    const text = await navigator.clipboard.readText();
    sendClipboardUpdate(text);
  } catch (err) {
    if (err.name === 'NotAllowedError') {
      console.warn('⚠️ Accès clipboard refusé sur ce site.');
      return;
    }
    const selection = window.getSelection()?.toString();
    if (selection) sendClipboardUpdate(selection);
  }
});

async function checkClipboard() {
  if (!isMonitoring) return;
  try {
    const text = await navigator.clipboard.readText();
    if (text && text.trim() !== '') sendClipboardUpdate(text);
  } catch (_) {}
}

console.log('🚀 Surveillance du presse-papiers...');
const checkInterval = setInterval(checkClipboard, 2500);

window.addEventListener('unload', stopMonitoring);
window.addEventListener('pagehide', stopMonitoring);

function stopMonitoring() {
  isMonitoring = false;
  clearInterval(checkInterval);
  console.log('🧹 Surveillance arrêtée.');
}

checkClipboard();
