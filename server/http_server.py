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
    def __init__(self, loop=None):
        self.clients = set()
        self.clipboard_content = ""
        self.history = []
        self.max_history = 3
        self.check_task = None
        self.loop = loop or asyncio.get_event_loop()
        logger.info("📋 ClipboardServer initialisé avec succès")
        
    async def cleanup(self):
        """Cleanup resources when shutting down"""
        if self.check_task and not self.check_task.done():
            self.check_task.cancel()
            try:
                await asyncio.wait_for(self.check_task, timeout=2.0)
            except (asyncio.CancelledError, asyncio.TimeoutError):
                logger.info("✅ Tâche de vérification du presse-papiers arrêtée")

    async def _send_heartbeat(self, client, message):
        """Envoie un heartbeat à un client spécifique"""
        try:
            if not client.closed:
                await client.send_json(message)
                logger.debug(f"💓 Heartbeat envoyé à {client.remote}")
                return True
            return False
        except Exception as e:
            logger.error(f"❌ Erreur envoi heartbeat à {client.remote}: {str(e)}")
            return False

    async def _cleanup_closed_clients(self):
        """Nettoie les clients déconnectés"""
        closed_clients = [c for c in self.clients if c.closed]
        for client in closed_clients:
            self.clients.discard(client)
        if closed_clients:
            logger.info(f"🗑️ {len(closed_clients)} clients déconnectés nettoyés")

    async def check_clipboard(self):
        """Boucle principale de vérification du presse-papiers"""
        logger.info("🚀 Serveur de presse-papiers démarré - En attente de contenu...")
        
        self.clipboard_content = ""
        self.history = []
        heartbeat_count = 0
        
        try:
            while True:
                try:
                    # Attendre l'intervalle de heartbeat
                    await asyncio.sleep(15)
                    heartbeat_count += 1
                    
                    # Nettoyer les clients déconnectés
                    await self._cleanup_closed_clients()
                    
                    # Log l'état actuel
                    if self.clients:
                        logger.info(f"🔄 {len(self.clients)} clients connectés (heartbeat #{heartbeat_count})")
                    else:
                        logger.debug(f"🔄 En attente de connexions... (heartbeat #{heartbeat_count})")

                    # Envoyer les heartbeats si nécessaire
                    if self.clients:
                        heartbeat_msg = {
                            'type': 'heartbeat',
                            'timestamp': datetime.now().isoformat(),
                            'count': heartbeat_count
                        }
                        
                        # Envoyer en parallèle à tous les clients
                        tasks = [self._send_heartbeat(client, heartbeat_msg) 
                               for client in list(self.clients)]
                        await asyncio.gather(*tasks, return_exceptions=True)
                        
                except asyncio.CancelledError:
                    logger.info("✅ Arrêt de la boucle de vérification demandé...")
                    raise
                    
                except Exception as e:
                    logger.error(f"❌ Erreur dans la boucle de vérification: {str(e)}", 
                               exc_info=not isinstance(e, asyncio.CancelledError))
                    await asyncio.sleep(5)  # Attendre avant de réessayer
                    
        except asyncio.CancelledError:
            logger.info("✅ Tâche de vérification arrêtée avec succès")
            raise
            
        except Exception as e:
            logger.critical(f"❌ Erreur fatale dans la boucle de vérification: {str(e)}", 
                          exc_info=True)
            raise
    async def broadcast_update(self):
        """Diffuse la mise à jour du presse-papiers à tous les clients connectés"""
        if not self.clipboard_content:
            logger.debug("Aucun contenu à diffuser")
            return

        try:
            message = {
                'type': 'clipboard_update',
                'content': self.clipboard_content,
                'history': [
                    {
                        'content': item['content'], 
                        'timestamp': item['timestamp'].isoformat()
                    } 
                    for item in self.history
                ]
            }
            
            clients_to_remove = set()
            active_clients = 0
            
            # Préparer les tâches d'envoi
            send_tasks = []
            for client in list(self.clients):
                if client.closed:
                    clients_to_remove.add(client)
                    continue
                    
                async def send_to_client(ws):
                    try:
                        await ws.send_json(message)
                        return True
                    except Exception as e:
                        client_address = ws._req.remote if hasattr(ws, '_req') and hasattr(ws._req, 'remote') else 'client inconnu'
                        logger.debug(f"Échec envoi à {client_address}: {e}")
                        clients_to_remove.add(ws)
                        return False
                
                send_tasks.append(send_to_client(client))
            
            # Exécuter les envois en parallèle
            if send_tasks:
                results = await asyncio.gather(*send_tasks, return_exceptions=True)
                active_clients = sum(1 for r in results if r is True)
            
            # Nettoyer les clients déconnectés
            if clients_to_remove:
                before = len(self.clients)
                self.clients -= clients_to_remove
                logger.info(f"🗑️ Nettoyage de {len(clients_to_remove)} clients déconnectés")
            
            logger.info(f"📡 Mise à jour diffusée à {active_clients} clients")
            
        except Exception as e:
            logger.error(f"❌ Erreur lors de la diffusion: {e}", exc_info=True)

    async def websocket_handler(self, request):
        """Gère les connexions WebSocket entrantes"""
        ws = web.WebSocketResponse(
            timeout=300,  # 5 minutes d'inactivité
            receive_timeout=300,  # 5 minutes
            heartbeat=30,  # Ping toutes les 30 secondes
            max_msg_size=10 * 1024 * 1024,  # 10MB
            autoping=True,
            autoclose=True
        )
        
        # Nettoyer les connexions fermées
        self.clients = {c for c in self.clients if not c.closed}
        
        try:
            await ws.prepare(request)
            self.clients.add(ws)
            
            client_info = f"{request.remote} (total: {len(self.clients)})"
            logger.info(f"🔗 Connexion établie: {client_info}")
            
            # Envoyer l'état initial
            try:
                if self.clipboard_content:
                    initial_msg = {
                        'type': 'clipboard_update',
                        'content': self.clipboard_content,
                        'history': [
                            {'content': item['content'], 
                             'timestamp': item['timestamp'].isoformat()}
                            for item in self.history
                        ]
                    }
                    await ws.send_json(initial_msg)
                    logger.debug(f"📤 État initial envoyé à {request.remote}")
                else:
                    await ws.send_json({
                        'type': 'status', 
                        'message': 'Bienvenue, prêt à synchroniser le presse-papier'
                    })
            except Exception as e:
                logger.error(f"❌ Erreur envoi état initial à {request.remote}: {e}")
            
            # Boucle de réception des messages
            async for msg in ws:
                if msg.type == web.WSMsgType.TEXT:
                    await self._handle_websocket_message(ws, msg)
                elif msg.type == web.WSMsgType.ERROR:
                    logger.error(f"❌ Erreur WebSocket avec {request.remote}: {ws.exception()}")
                    break
                elif msg.type == web.WSMsgType.CLOSE:
                    logger.info(f"🔌 Déconnexion de {request.remote} (code: {ws.close_code})")
                    break
                
        except asyncio.CancelledError:
            logger.info(f"🔌 Connexion annulée: {request.remote}")
            raise
            
        except Exception as e:
            logger.error(f"❌ Erreur avec {request.remote}: {e}", exc_info=True)
            
        finally:
            # Nettoyage
            if not ws.closed:
                try:
                    await ws.close()
                except Exception as e:
                    logger.error(f"❌ Erreur lors de la fermeture de la connexion: {e}")
            
            self.clients.discard(ws)
            logger.info(f"👋 Déconnecté: {request.remote} (restants: {len(self.clients)})")
            
        return ws
        
    async def _handle_websocket_message(self, ws, msg):
        """Traite un message WebSocket entrant"""
        try:
            data = json.loads(msg.data)
            msg_type = data.get('type', 'unknown')
            client_address = ws._req.remote if hasattr(ws, '_req') and hasattr(ws._req, 'remote') else 'client inconnu'
            logger.debug(f" Message {msg_type} de {client_address}")
            
            if msg_type == 'clipboard_update':
                await self._process_clipboard_update(data, client_address)
                
        except json.JSONDecodeError:
            client_address = ws._req.remote if hasattr(ws, '_req') and hasattr(ws._req, 'remote') else 'client inconnu'
            logger.error(f" Message JSON invalide de {client_address}: {msg.data[:100]}")
        except Exception as e:
            logger.error(f" Erreur traitement message de {client_address}: {e}", exc_info=True)
    
    async def _process_clipboard_update(self, data, remote):
        """Traite une mise à jour du presse-papiers"""
        try:
            if 'content' not in data:
                return
                
            self.clipboard_content = data['content']
            self.history.insert(0, {
                'content': self.clipboard_content,
                'timestamp': datetime.now()
            })
            
            # Limiter l'historique
            if hasattr(self, 'max_history') and len(self.history) > self.max_history:
                self.history = self.history[:self.max_history]
                
            # Diffuser la mise à jour
            await self.broadcast_update()
            
        except Exception as e:
            logger.error(f"❌ Erreur traitement mise à jour de {remote}: {e}", exc_info=True)

@middleware
async def cors_middleware(request, handler):
    response = await handler(request)
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type'
    return response

async def create_app(loop=None):
    # Configuration du serveur avec des timeouts plus longs
    app = web.Application(middlewares=[cors_middleware], client_max_size=1024*1024*10, loop=loop)
    
    # Configuration des timeouts
    app['websocket_timeout'] = 300  # 5 minutes
    app['keepalive_timeout'] = 300  # 5 minutes
    
    server = ClipboardServer(loop=loop)
    
    # Nettoyage lors de l'arrêt de l'application
    async def on_shutdown(app):
        logger.info("🔌 Nettoyage des ressources de l'application...")
        await server.cleanup()
        
    async def on_startup(app):
        # Créer et stocker la tâche de vérification dans le bon event loop
        server.check_task = asyncio.create_task(server.check_clipboard())
    
    app.on_startup.append(on_startup)
    app.on_shutdown.append(on_shutdown)
    
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

class ServerManager:
    def __init__(self):
        self.server_started = False
        self.loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.loop)
        self.setup_signal_handlers()

    def setup_signal_handlers(self):
        for signame in ('SIGINT', 'SIGTERM'):
            self.loop.add_signal_handler(
                getattr(signal, signame),
                lambda s=signame: self.handle_shutdown(s)
            )

    def handle_shutdown(self, signame):
        """Méthode conservée pour compatibilité, mais non utilisée directement"""
        if not self.server_started:
            logger.info("\n✅ Arrêt du serveur avant le démarrage complet...")
            self.loop.stop()
            return

    def run(self):
        try:
            logger.info("🔧 Démarrage du serveur clipboard...")
            app = self.loop.run_until_complete(create_app(loop=self.loop))
            self.server_started = True
            logger.info("✅ Serveur démarré avec succès et prêt à accepter des connexions")
            
            # Créer le runner et démarrer le serveur manuellement
            runner = web.AppRunner(app)
            self.loop.run_until_complete(runner.setup())
            site = web.TCPSite(runner, '0.0.0.0', 24900)
            self.loop.run_until_complete(site.start())
            
            # Désactiver la gestion des signaux par aiohttp
            # et utiliser notre propre gestionnaire
            def shutdown():
                logger.info("\n👋 Arrêt du serveur demandé...")
                # Annuler toutes les tâches en cours
                for task in asyncio.all_tasks(loop=self.loop):
                    task.cancel()
                # Arrêter le serveur
                self.loop.create_task(runner.cleanup())
                # Arrêter la boucle d'événements
                self.loop.stop()
            
            # Configurer les gestionnaires de signaux
            for signame in ('SIGINT', 'SIGTERM'):
                self.loop.add_signal_handler(
                    getattr(signal, signame),
                    shutdown
                )
            
            # Lancer la boucle d'événements
            logger.info("Appuyez sur Ctrl+C pour arrêter le serveur")
            self.loop.run_forever()
            
        except KeyboardInterrupt:
            logger.info("\n👋 Arrêt du serveur demandé via Ctrl+C")
        except Exception as e:
            logger.error(f"❌ Erreur lors du démarrage du serveur: {e}")
            raise
        finally:
            if self.server_started:
                logger.info("👋 Arrêt du serveur effectué avec succès")
            # Nettoyer les tâches restantes
            tasks = asyncio.all_tasks(loop=self.loop)
            for task in tasks:
                task.cancel()
            # Attendre que les tâches soient annulées
            if tasks:
                self.loop.run_until_complete(asyncio.gather(*tasks, return_exceptions=True))
            # Fermer la boucle d'événements
            self.loop.close()

if __name__ == '__main__':
    import signal
    server = ServerManager()
    server.run()