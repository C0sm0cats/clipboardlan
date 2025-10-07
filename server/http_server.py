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
        self.clients = {}  # Dictionnaire pour stocker les clients avec leur ID
        self.client_info = {}  # Dictionnaire pour stocker les infos des clients (adresse IP, ID machine, etc.)
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
        closed_clients = [client_id for client_id, client in self.clients.items() if client.closed]
        for client_id in closed_clients:
            self.clients.pop(client_id, None)
            self.client_info.pop(client_id, None)
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
    async def broadcast_update(self, origin_client_id=None):
        """Diffuse la mise à jour du presse-papiers à tous les clients connectés"""
        if not self.clipboard_content:
            logger.debug("Aucun contenu à diffuser")
            return

        try:
            # Préparer l'historique pour l'envoi
            history_to_send = []
            for item in self.history:
                # Gérer le timestamp qu'il soit une chaîne ou un objet datetime
                timestamp = item.get('timestamp')
                if hasattr(timestamp, 'isoformat'):
                    timestamp_str = timestamp.isoformat()
                else:
                    # Si c'est déjà une chaîne, l'utiliser directement
                    timestamp_str = str(timestamp) if timestamp is not None else datetime.now().isoformat()
                
                history_to_send.append({
                    'content': item.get('content', ''),
                    'timestamp': timestamp_str,
                    'machine_id': item.get('machine_id', 'unknown'),
                    'hostname': item.get('hostname', 'Unknown'),
                    'source': item.get('source', 'unknown')
                })
            
            message = {
                'type': 'clipboard_update',
                'content': self.clipboard_content,
                'history': history_to_send
            }
            
            # Ajouter l'ID de la machine d'origine si disponible
            if origin_client_id:
                message['origin_machine_id'] = origin_client_id
            
            clients_to_remove = set()
            active_clients = 0
            
            # Préparer les tâches d'envoi
            send_tasks = []
            for client_id, client_ws in list(self.clients.items()):
                if client_ws.closed:
                    clients_to_remove.add(client_ws)
                    continue
                    
                async def send_to_client(ws, cid):
                    try:
                        # Ajouter l'ID de la machine d'origine au message
                        client_message = message.copy()
                        client_message['current_machine_id'] = cid
                        await ws.send_json(client_message)
                        return True
                    except Exception as e:
                        client_address = ws._req.remote if hasattr(ws, '_req') and hasattr(ws._req, 'remote') else 'client inconnu'
                        logger.debug(f"Échec envoi à {client_address}: {e}")
                        clients_to_remove.add(ws)
                        return False
                
                send_tasks.append(send_to_client(client_ws, client_id))
            
            # Exécuter les envois en parallèle
            if send_tasks:
                results = await asyncio.gather(*send_tasks, return_exceptions=True)
                active_clients = sum(1 for r in results if r is True)
            
            # Nettoyer les clients déconnectés
            if clients_to_remove:
                before = len(self.clients)
                for client_id in clients_to_remove:
                    self.clients.pop(client_id, None)
                    self.client_info.pop(client_id, None)
                logger.info(f"🗑️ Nettoyage de {len(clients_to_remove)} clients déconnectés")
                
            return active_clients
            
        except Exception as e:
            return 0
    
    async def websocket_handler(self, request):
        """Gère les connexions WebSocket entrantes"""
        ws = web.WebSocketResponse(
            heartbeat=30.0,
            max_msg_size=10*1024*1024,  # 10MB max
            timeout=300.0,  # 5 minutes
            autoping=True,
            receive_timeout=300.0
        )
        
        # Générer un ID unique pour ce client
        client_id = f"{request.remote}_{id(ws)}"
        
        try:
            await ws.prepare(request)
            
            # Ajouter le client aux listes
            self.clients[client_id] = ws
            self.client_info[client_id] = {
                'ip': request.remote,
                'connected_at': datetime.now().isoformat(),
                'last_seen': datetime.now().isoformat()
            }
            
            logger.info(f"🔗 Connexion établie: {request.remote} (ID: {client_id[:8]}...)")
            
            # Envoyer l'état initial
            try:
                if self.clipboard_content:
                    # Préparer l'historique pour l'envoi initial
                    history_to_send = []
                    for item in self.history:
                        # Gérer le timestamp qu'il soit une chaîne ou un objet datetime
                        timestamp = item.get('timestamp')
                        if hasattr(timestamp, 'isoformat'):
                            timestamp_str = timestamp.isoformat()
                        else:
                            timestamp_str = str(timestamp) if timestamp is not None else datetime.now().isoformat()
                        
                        history_to_send.append({
                            'content': item.get('content', ''),
                            'timestamp': timestamp_str,
                            'machine_id': item.get('machine_id', 'unknown'),
                            'hostname': item.get('hostname', 'Unknown'),
                            'source': item.get('source', 'unknown')
                        })
                    
                    initial_msg = {
                        'type': 'clipboard_update',
                        'content': self.clipboard_content,
                        'history': history_to_send,
                        'client_id': client_id
                    }
                    await ws.send_json(initial_msg)
                    logger.debug(f"📤 État initial envoyé à {request.remote}")
                else:
                    await ws.send_json({
                        'type': 'status', 
                        'message': 'Bienvenue, prêt à synchroniser le presse-papier',
                        'client_id': client_id
                    })
                
                # Envoyer également les informations de connexion actuelles
                await ws.send_json({
                    'type': 'connection_info',
                    'status': 'connected',
                    'client_id': client_id,
                    'server_time': datetime.now().isoformat()
                })
                
            except Exception as e:
                logger.error(f"❌ Erreur envoi état initial à {request.remote}: {e}", exc_info=True)
            
            # Boucle de réception des messages
            async for msg in ws:
                if msg.type == web.WSMsgType.TEXT:
                    # Mettre à jour le last_seen
                    if client_id in self.client_info:
                        self.client_info[client_id]['last_seen'] = datetime.now().isoformat()
                    await self._handle_websocket_message(ws, msg, client_id)
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
            
            # Supprimer le client des listes
            self.clients.pop(client_id, None)
            self.client_info.pop(client_id, None)
            
            logger.info(f"👋 Déconnecté: {request.remote} (restants: {len(self.clients)})")
            
        return ws
        
    async def _handle_websocket_message(self, ws, msg, client_id=None):
        """Traite un message WebSocket entrant"""
        try:
            data = json.loads(msg.data)
            msg_type = data.get('type', 'unknown')
            
            # Obtenir les infos du client
            client_info = self.client_info.get(client_id, {})
            client_ip = client_info.get('ip', 'inconnu')
            
            logger.debug(f"📥 Message {msg_type} reçu de {client_ip} (ID: {client_id[:8] if client_id else 'inconnu'})")
            logger.debug(f"📋 Contenu du message: {json.dumps(data, ensure_ascii=False)[:200]}...")
            
            if msg_type == 'client_identify':
                # Mettre à jour les informations du client
                if client_id:
                    self.client_info[client_id].update({
                        'machine_id': data.get('machine_id', client_id),
                        'hostname': data.get('hostname', 'Unknown'),
                        'user_agent': data.get('user_agent', 'Unknown'),
                        'last_seen': datetime.now().isoformat()
                    })
                    logger.info(f"🆔 Client identifié: {self.client_info[client_id]['hostname']} ({client_id[:8]}...)")
                    
                    # Envoyer un accueil personnalisé
                    welcome_msg = {
                        'type': 'status',
                        'message': f'Connecté en tant que {self.client_info[client_id]["hostname"]}'
                    }
                    await ws.send_json(welcome_msg)
                    
            elif msg_type == 'clipboard_update':
                logger.info(f"📋 Mise à jour du presse-papiers reçue de {client_ip} (ID: {client_id[:8] if client_id else 'inconnu'})")
                logger.debug(f"📋 Données brutes: {data}")
                
                # Ajouter les infos de la machine d'origine
                if client_id and client_id in self.client_info:
                    # Toujours utiliser le hostname du client s'il est disponible
                    client_hostname = self.client_info[client_id].get('hostname', 'Unknown')
                    
                    logger.debug(f"🔍 Client trouvé: ID={client_id}, Hostname={client_hostname}")
                    
                    # Mettre à jour les données avec les informations du client
                    data.update({
                        'machine_id': client_id,
                        'hostname': client_hostname,
                        'source': 'remote',
                        'timestamp': datetime.now().isoformat()
                    })
                else:
                    logger.warning(f"⚠️ Client non trouvé pour l'ID: {client_id}")
                
                # Traiter la mise à jour du presse-papiers
                logger.debug("🔄 Traitement de la mise à jour du presse-papiers...")
                await self._process_clipboard_update(data, client_ip)
                logger.info("✅ Mise à jour du presse-papiers traitée avec succès")
                
        except json.JSONDecodeError as e:
            logger.error(f" Message JSON invalide de {client_ip}: {msg.data[:100]}")
        except Exception as e:
            logger.error(f" Erreur traitement message de {client_ip}: {str(e)}")
            logger.debug("Détails de l'erreur:", exc_info=True)
    
    async def _process_clipboard_update(self, data, remote):
        """Traite une mise à jour du presse-papiers"""
        try:
            logger.debug(f"🔧 Traitement de la mise à jour du presse-papiers de {remote}")
            logger.debug(f"📄 Données reçues: {json.dumps(data, ensure_ascii=False)[:500]}...")
            
            if 'content' not in data:
                logger.warning(f"⚠️ Mise à jour du presse-papiers sans contenu reçue de {remote}")
                return
                
            logger.debug(f"📝 Contenu reçu (longueur: {len(str(data.get('content', '')))})")
            
            # Préparer l'élément avec des valeurs par défaut cohérentes
            timestamp = data.get('timestamp')
            if not timestamp:
                timestamp = datetime.now().isoformat()
            
            # Créer le nouvel élément avec toutes les métadonnées disponibles
            new_item = {
                'content': data['content'],
                'timestamp': timestamp,
                'machine_id': data.get('machine_id', 'unknown'),
                'hostname': data.get('hostname', 'Unknown'),
                'source': data.get('source', 'unknown'),
                'remote': remote
            }
            
            # Mettre à jour le contenu du presse-papiers
            self.clipboard_content = data['content']
            
            # Ajouter à l'historique
            self.history.insert(0, new_item)
            
            # Limiter la taille de l'historique
            if hasattr(self, 'max_history') and len(self.history) > self.max_history:
                self.history = self.history[:self.max_history]
                
            # Diffuser la mise à jour à tous les clients connectés
            logger.debug("📢 Diffusion de la mise à jour à tous les clients...")
            await self.broadcast_update()
            logger.debug("✅ Mise à jour diffusée avec succès")
            
            logger.info(f"📋 Presse-papiers mis à jour par {new_item.get('hostname', 'unknown')} ({remote})")
            logger.debug(f"📋 Nouveau contenu: {str(new_item.get('content', ''))[:100]}...")
            
        except Exception as e:
            logger.error(f"❌ Erreur lors du traitement de la mise à jour du presse-papiers de {remote}: {e}", exc_info=True)
            
    async def handle_hostname(self, request):
        """Renvoie le nom d'hôte du serveur"""
        import socket
        hostname = socket.gethostname()
        return web.json_response({
            'hostname': hostname,
            'fqdn': socket.getfqdn(),
            'ip': socket.gethostbyname(hostname)
        })

@middleware
async def cors_middleware(request, handler):
    response = await handler(request)
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type'
    return response

async def create_app(loop=None):
    # Configuration du serveur avec des timeouts plus longs
    app = web.Application(middlewares=[cors_middleware],
                         client_max_size=1024*1024*10,
                         loop=loop)
    
    # Configuration des timeouts et tailles maximales
    app['client_timeout'] = 300  # 5 minutes
    app['websocket_timeout'] = 300  # 5 minutes
    app['keepalive_timeout'] = 300  # 5 minutes
    app['ping_interval'] = 30  # Envoi d'un ping toutes les 30 secondes
    app['websocket_max_msg_size'] = 10 * 1024 * 1024  # 10MB
    
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
    app.router.add_route('GET', '/hostname', server.handle_hostname)
    app.router.add_route('GET', '/', lambda req: web.json_response({
        'status': 'ok', 
        'message': 'Clipboard server running',
        'version': '1.0.0',
        'websocket_timeout': '300s',
        'keepalive': 'enabled',
        'endpoints': {
            'ws': '/ws',
            'health': '/health',
            'hostname': '/hostname'
        }
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