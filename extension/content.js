console.log('Content script loaded');

// Surveiller les changements de sélection (qui se produisent souvent lors d'un copier)
document.addEventListener('copy', () => {
  // Récupérer le contenu du presse-papiers
  navigator.clipboard.readText()
    .then(text => {
      console.log('Contenu copié détecté:', text);
      // Envoyer le contenu au script d'arrière-plan
      chrome.runtime.sendMessage({
        type: 'CLIPBOARD_CHANGE',
        content: text
      });
    })
    .catch(err => {
      console.error('Erreur lors de la lecture du presse-papiers:', err);
    });
});

// Fonction pour détecter les changements de presse-papiers
async function checkClipboard() {
  try {
    const text = await navigator.clipboard.readText();
    if (text && text.trim() !== '') {
      console.log('Contenu du presse-papiers détecté:', text);
      chrome.runtime.sendMessage({
        type: 'CLIPBOARD_CHANGE',
        content: text
      });
    }
  } catch (err) {
    console.error('Erreur lors de la vérification du presse-papiers:', err);
  }
}

// Vérifier périodiquement le presse-papiers
setInterval(checkClipboard, 1000); // Vérifier toutes les secondes

// Vérifier aussi au chargement
checkClipboard();