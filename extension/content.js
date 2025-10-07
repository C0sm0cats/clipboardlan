console.log('Content script chargé sur:', window.location.href);

let lastClipboardContent = '';
let isMonitoring = true;

// Fonction pour envoyer la mise à jour au background
function sendClipboardUpdate(text) {
  if (!text || text === lastClipboardContent) return;
  
  console.log('📋 Nouveau contenu détecté dans le presse-papiers:', 
    text.length > 50 ? text.substring(0, 50) + '...' : text
  );
  
  lastClipboardContent = text;
  
  chrome.runtime.sendMessage({
    type: 'CLIPBOARD_CHANGE',
    content: text,
    url: window.location.href,
    timestamp: new Date().toISOString()
  }).catch(err => {
    console.error('❌ Erreur lors de l\'envoi au background:', err);
  });
}

// Détection via l'événement copy
document.addEventListener('copy', async (event) => {
  try {
    console.log('Événement de copie détecté');
    const text = await navigator.clipboard.readText();
    sendClipboardUpdate(text);
  } catch (err) {
    console.error('❌ Erreur lors de la lecture du presse-papiers (copy event):', {
      name: err.name,
      message: err.message,
      stack: err.stack
    });
    // Essayer avec la méthode de secours
    try {
      const selection = window.getSelection().toString();
      if (selection) {
        sendClipboardUpdate(selection);
      }
    } catch (e) {
      console.error('❌ Échec de la méthode de secours:', e);
    }
  }
});

// Vérification périodique du presse-papiers
async function checkClipboard() {
  if (!isMonitoring) return;
  
  try {
    const text = await navigator.clipboard.readText();
    if (text && text.trim() !== '') {
      sendClipboardUpdate(text);
    }
  } catch (err) {
    console.error('❌ Erreur lors de la vérification du presse-papiers:', {
      name: err.name,
      message: err.message,
      stack: err.stack
    });
  }
}

// Démarrer la surveillance
console.log('🚀 Démarrage de la surveillance du presse-papiers...');
const checkInterval = setInterval(checkClipboard, 1000);

// Nettoyage
window.addEventListener('unload', () => {
  isMonitoring = false;
  clearInterval(checkInterval);
  console.log('🧹 Arrêt de la surveillance du presse-papiers');
});

// Vérification initiale
checkClipboard();