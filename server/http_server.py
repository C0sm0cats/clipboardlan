from aiohttp import web
from aiohttp.web import middleware
import asyncio
import json
import logging
from datetime import datetime

# Configuration du logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger('HTTPClipboardServer')

class ClipboardServer:
    def __init__(self):
        self.clients = set()
        self.clipboard_content = ""
        self.history = []
        self.max_history = 3
        logger.info("📋 ClipboardServer initialisé avec succès")

    async def check_clipboard(self):
        logger.info("🚀 Serveur de presse-papiers démarré - En attente de contenu...")
        
        # Initialiser avec un historique vide
        self.clipboard_content = ""
        self.history = []
        
        # Garder le serveur actif pour accepter de nouvelles connexions
        heartbeat_count = 0
        while True:
            await asyncio.sleep(15)  # Envoyer un heartbeat toutes les 15 secondes
            heartbeat_count += 1
            if self.clients:
                logger.info(f"🔄 Serveur actif - {len(self.clients)} clients connectés (heartbeat #{heartbeat_count})")
            else:
                logger.debug(f"🔄 Serveur en attente de connexions... (heartbeat #{heartbeat_count})")

            # Envoyer un message de heartbeat aux clients connectés pour maintenir la connexion
            if self.clients:
                heartbeat_message = {
                    'type': 'heartbeat',
                    'timestamp': datetime.now().isoformat(),
                    'message': f'Server active - {heartbeat_count} heartbeats sent'
                }
                disconnected_clients = []
                for client in list(self.clients):
                    try:
                        if not client.closed:
                            await client.send_json(heartbeat_message)
                            logger.info(f"💓 Heartbeat envoyé à un client")
                        else:
                            logger.warning(f"❌ Client fermé détecté")
                            disconnected_clients.append(client)
                    except Exception as e:
                        logger.error(f"❌ Erreur envoi heartbeat à client: {e}")
                        disconnected_clients.append(client)

                for client in disconnected_clients:
                    self.clients.discard(client)
                    logger.info(f"🗑️ Client supprimé de la liste")
            else:
                logger.info("🔄 Aucun client connecté - attente de connexions")
    async def broadcast_update(self):
        if not self.clipboard_content:
            return

        message = {
            'type': 'clipboard_update',
            'content': self.clipboard_content,
            'history': [{'content': item['content'], 'timestamp': item['timestamp'].isoformat()} for item in self.history]
        }

        logger.info(f"📡 Diffusion de mise à jour clipboard à {len(self.clients)} clients")
        disconnected_clients = []
        for client in list(self.clients):
            try:
                if not client.closed:
                    await client.send_json(message)
                    logger.info(f"✅ Message envoyé à un client")
                else:
                    logger.warning(f"❌ Client fermé détecté")
                    disconnected_clients.append(client)
            except Exception as e:
                logger.error(f"❌ Erreur envoi message à client: {e}")
                disconnected_clients.append(client)

        for client in disconnected_clients:
            self.clients.discard(client)
            logger.info(f"🗑️ Client supprimé de la liste")

    async def websocket_handler(self, request):
        # Configuration du WebSocket avec des timeouts plus longs
        ws = web.WebSocketResponse(
            timeout=300,  # 5 minutes d'inactivité
            receive_timeout=300,  # 5 minutes
            heartbeat=30,  # Ping toutes les 30 secondes
            max_msg_size=10 * 1024 * 1024,  # 10MB
            autoping=True,
            autoclose=True  # Permettre la fermeture automatique pour un meilleur nettoyage
        )
        
        # Nettoyage des connexions fermées
        self.clients = {client for client in self.clients if not client.closed}
        
        await ws.prepare(request)
        self.clients.add(ws)
        
        client_info = f"{request.remote} (total: {len(self.clients)})"
        logger.info(f"🔗 Nouveau client WebSocket connecté: {client_info}")
        
        # Envoyer un ping immédiat pour maintenir la connexion
        try:
            await ws.ping()
        except Exception as e:
            logger.error(f"❌ Erreur lors de l'envoi du ping initial: {e}")

        # Envoyer immédiatement l'historique actuel au nouveau client
        try:
            if self.clipboard_content:
                initial_message = {
                    'type': 'clipboard_update',
                    'content': self.clipboard_content,
                    'history': [{'content': item['content'], 'timestamp': item['timestamp'].isoformat()} for item in self.history]
                }
                await ws.send_json(initial_message)
                logger.info(f"📤 Historique initial envoyé: {len(self.history)} éléments")
            else:
                await ws.send_json({'type': 'status', 'message': 'Bienvenue, prêt à synchroniser le presse-papier'})
                
            async for msg in ws:
                if msg.type == web.WSMsgType.TEXT:
                    try:
                        data = json.loads(msg.data)
                        logger.debug(f"📨 Message reçu du client: {data.get('type', 'unknown')}")
                        if data.get('type') == 'clipboard_update':
                            self.clipboard_content = data['content']
                            self.history.insert(0, {'content': data['content'], 'timestamp': datetime.now()})
                            if hasattr(self, 'max_history') and len(self.history) > self.max_history:
                                self.history = self.history[:self.max_history]
                            await self.broadcast_update()
                    except json.JSONDecodeError:
                        logger.error("❌ Erreur de décodage JSON du message client")
                    except Exception as e:
                        logger.error(f"❌ Erreur traitement message client: {e}")
                
                # Gérer les messages de contrôle
                elif msg.type == web.WSMsgType.ERROR:
                    logger.error(f"❌ Erreur WebSocket: {ws.exception()}")
                    break
                    
        except asyncio.CancelledError:
            logger.info("🔌 Connexion WebSocket annulée")
            raise
        except Exception as e:
            logger.error(f"❌ Erreur dans le gestionnaire WebSocket: {e}")
        finally:
            if not ws.closed:
                await ws.close()
            self.clients.discard(ws)
            logger.info(f"❌ Client WebSocket déconnecté. Restants: {len(self.clients)}")
            
        return ws

@middleware
async def cors_middleware(request, handler):
    response = await handler(request)
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type'
    return response

async def create_app():
    # Configuration du serveur avec des timeouts plus longs
    app = web.Application(middlewares=[cors_middleware], client_max_size=1024*1024*10)
    
    # Configuration des timeouts
    app['websocket_timeout'] = 300  # 5 minutes
    app['keepalive_timeout'] = 300  # 5 minutes
    
    server = ClipboardServer()
    # Utiliser la version de test pour le debugging
    asyncio.create_task(server.check_clipboard())
    
    # Configuration des routes
    app.router.add_route('GET', '/ws', server.websocket_handler)
    app.router.add_route('GET', '/health', lambda req: web.json_response({'status': 'ok'}))
    app.router.add_route('GET', '/', lambda req: web.json_response({
        'status': 'ok', 
        'message': 'Clipboard server running',
        'version': '1.0.0',
        'websocket_timeout': '300s',
        'keepalive': 'enabled'
    }))
    logger.info("🚀 Serveur HTTP WebSocket démarré sur http://0.0.0.0:24900")
    logger.info("📡 WebSocket endpoint: ws://0.0.0.0:24900/ws")
    logger.info("🏥 Health endpoint: http://0.0.0.0:24900/health")
    logger.info("🏠 Root endpoint: http://0.0.0.0:24900/")
    return app

if __name__ == '__main__':
    logger.info("🔧 Démarrage du serveur clipboard...")
    app = asyncio.run(create_app())
    
    # Configuration du serveur avec des timeouts plus longs
    web.run_app(
        app,
        host='0.0.0.0',
        port=24900,
        keepalive_timeout=300,  # 5 minutes
        ssl_context=None
    )
    logger.info("✅ Serveur démarré avec succès")