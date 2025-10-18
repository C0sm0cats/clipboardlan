from aiohttp import web
from aiohttp.web import middleware
import asyncio
import json
import logging
import signal
import socket
from datetime import datetime

# Configuration du logging
logging.basicConfig(level=logging.INFO,
                    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger('HTTPClipboardServer')


class ClipboardServer:
    def __init__(self, max_history=3):
        self.clients = {}  # client_id -> WebSocketResponse
        self.client_info = {}  # client_id -> infos (ip, hostname, etc.)
        self.clipboard_content = ""
        self.history = []
        self.max_history = max_history
        self.check_task = None
        logger.info("📋 ClipboardServer initialisé avec succès")

    async def cleanup(self):
        """Nettoyage lors de l’arrêt du serveur."""
        if self.check_task and not self.check_task.done():
            self.check_task.cancel()
            try:
                await asyncio.wait_for(self.check_task, timeout=2.0)
            except (asyncio.CancelledError, asyncio.TimeoutError):
                logger.info("✅ Tâche de vérification du presse-papiers arrêtée")

    async def _send_heartbeat(self, client, message):
        """Envoie un heartbeat à un client."""
        try:
            if not client.closed:
                await client.send_json(message)
                return True
        except Exception as e:
            logger.debug(f"❌ Erreur envoi heartbeat : {e}")
        return False

    async def _cleanup_closed_clients(self):
        """Supprime les clients déconnectés."""
        closed_clients = [cid for cid, ws in self.clients.items() if ws.closed]
        for cid in closed_clients:
            self.clients.pop(cid, None)
            self.client_info.pop(cid, None)
        if closed_clients:
            logger.info(f"🗑️ {len(closed_clients)} clients déconnectés nettoyés")

    async def check_clipboard(self):
        """Boucle de heartbeat et nettoyage."""
        logger.info("🚀 Serveur de presse-papiers prêt - en attente de connexions...")
        heartbeat_count = 0
        try:
            while True:
                await asyncio.sleep(15)
                heartbeat_count += 1
                await self._cleanup_closed_clients()

                if self.clients:
                    logger.info(f"🔄 {len(self.clients)} clients connectés (heartbeat #{heartbeat_count})")
                    heartbeat_msg = {
                        'type': 'heartbeat',
                        'timestamp': datetime.now().isoformat(),
                        'count': heartbeat_count
                    }
                    tasks = [self._send_heartbeat(ws, heartbeat_msg)
                             for ws in list(self.clients.values())]
                    await asyncio.gather(*tasks, return_exceptions=True)
                else:
                    logger.debug(f"🕓 Aucun client connecté (heartbeat #{heartbeat_count})")

        except asyncio.CancelledError:
            logger.info("✅ Boucle de vérification arrêtée proprement")
        except Exception as e:
            logger.error(f"❌ Erreur dans la boucle principale: {e}", exc_info=True)

    async def broadcast_update(self, origin_client_id=None):
        """Diffuse la mise à jour du presse-papiers à tous les clients."""
        if not self.clipboard_content:
            logger.debug("Aucun contenu à diffuser")
            return

        try:
            history_to_send = []
            for item in self.history:
                ts = item.get('timestamp')
                ts_str = ts.isoformat() if hasattr(ts, 'isoformat') else str(ts)
                history_to_send.append({
                    'content': item.get('content', ''),
                    'timestamp': ts_str,
                    'machine_id': item.get('machine_id', 'unknown'),
                    'hostname': item.get('hostname', 'Unknown'),
                    'source': item.get('source', 'unknown')
                })

            message = {
                'type': 'clipboard_update',
                'content': self.clipboard_content,
                'history': history_to_send
            }

            if origin_client_id:
                message['origin_machine_id'] = origin_client_id

            clients_to_remove = set()
            send_tasks = []

            for cid, ws in list(self.clients.items()):
                if ws.closed:
                    clients_to_remove.add(cid)
                    continue

                async def send_to_client(ws, cid):
                    try:
                        msg_copy = message.copy()
                        msg_copy['current_machine_id'] = cid
                        await ws.send_json(msg_copy)
                        return True
                    except Exception as e:
                        logger.debug(f"⚠️ Envoi échoué à {cid[:8]}: {e}")
                        clients_to_remove.add(cid)
                        return False

                send_tasks.append(send_to_client(ws, cid))

            if send_tasks:
                await asyncio.gather(*send_tasks, return_exceptions=True)

            # Nettoyer les clients déconnectés
            for cid in clients_to_remove:
                self.clients.pop(cid, None)
                self.client_info.pop(cid, None)

            if clients_to_remove:
                logger.info(f"🗑️ {len(clients_to_remove)} clients supprimés après échec d’envoi")

        except Exception as e:
            logger.error(f"❌ Erreur diffusion clipboard: {e}", exc_info=True)

    async def websocket_handler(self, request):
        """Gère les connexions WebSocket."""
        ws = web.WebSocketResponse(
            heartbeat=30.0,
            max_msg_size=10 * 1024 * 1024,
            timeout=300.0,
            autoping=True,
            receive_timeout=300.0
        )

        client_id = f"{request.remote}_{id(ws)}"
        await ws.prepare(request)

        self.clients[client_id] = ws
        self.client_info[client_id] = {
            'ip': request.remote,
            'connected_at': datetime.now().isoformat(),
            'last_seen': datetime.now().isoformat()
        }

        logger.info(f"🔗 Client connecté: {request.remote} (ID: {client_id[:8]})")

        try:
            await ws.send_json({
                'type': 'status',
                'message': 'Bienvenue, prêt à synchroniser le presse-papiers',
                'client_id': client_id
            })

            async for msg in ws:
                if msg.type == web.WSMsgType.TEXT:
                    self.client_info[client_id]['last_seen'] = datetime.now().isoformat()
                    await self._handle_websocket_message(ws, msg, client_id)
                elif msg.type in (web.WSMsgType.ERROR, web.WSMsgType.CLOSE):
                    break

        except Exception as e:
            logger.error(f"❌ Erreur WebSocket {request.remote}: {e}", exc_info=True)
        finally:
            await ws.close()
            self.clients.pop(client_id, None)
            self.client_info.pop(client_id, None)
            logger.info(f"👋 Déconnecté: {request.remote}")

        return ws

    async def _handle_websocket_message(self, ws, msg, client_id):
        """Traite un message WebSocket entrant."""
        try:
            data = json.loads(msg.data)
            msg_type = data.get('type')

            if msg_type == 'client_identify':
                self.client_info[client_id].update({
                    'machine_id': data.get('machine_id', client_id),
                    'hostname': data.get('hostname', 'Unknown'),
                    'user_agent': data.get('user_agent', 'Unknown'),
                    'last_seen': datetime.now().isoformat()
                })
                await ws.send_json({
                    'type': 'status',
                    'message': f"Connecté en tant que {self.client_info[client_id]['hostname']}"
                })

            elif msg_type == 'clipboard_update':
                await self._process_clipboard_update(data, self.client_info[client_id]['ip'])

        except json.JSONDecodeError:
            logger.warning(f"⚠️ Message JSON invalide de {client_id[:8]}")
        except Exception as e:
            logger.error(f"❌ Erreur traitement message: {e}", exc_info=True)

    async def _process_clipboard_update(self, data, remote):
        """Met à jour le presse-papiers et diffuse."""
        try:
            content = data.get('content')
            if not content:
                logger.debug(f"⚠️ Mise à jour sans contenu de {remote}")
                return

            new_item = {
                'content': content,
                'timestamp': datetime.now().isoformat(),
                'machine_id': data.get('machine_id', 'unknown'),
                'hostname': data.get('hostname', 'Unknown'),
                'source': 'remote',
                'remote': remote
            }

            self.clipboard_content = content
            self.history.insert(0, new_item)
            self.history = self.history[:self.max_history]

            await self.broadcast_update()
            logger.info(f"📋 Presse-papiers mis à jour par {new_item['hostname']} ({remote})")

        except Exception as e:
            logger.error(f"❌ Erreur update clipboard: {e}", exc_info=True)

    async def handle_hostname(self, _):
        """Renvoie le nom d’hôte du serveur."""
        hostname = socket.gethostname()
        return web.json_response({
            'hostname': hostname,
            'fqdn': socket.getfqdn(),
            'ip': socket.gethostbyname(hostname)
        })


@middleware
async def cors_middleware(request, handler):
    response = await handler(request)
    response.headers.update({
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
    })
    return response


async def create_app():
    """Crée l’application aiohttp."""
    app = web.Application(middlewares=[cors_middleware],
                          client_max_size=10 * 1024 * 1024)

    server = ClipboardServer(max_history=5)

    async def on_startup(_):
        server.check_task = asyncio.create_task(server.check_clipboard())

    async def on_shutdown(_):
        logger.info("🔌 Nettoyage des ressources...")
        await server.cleanup()

    app.on_startup.append(on_startup)
    app.on_shutdown.append(on_shutdown)

    app.router.add_get('/ws', server.websocket_handler)
    app.router.add_get('/hostname', server.handle_hostname)
    app.router.add_get('/health', lambda _: web.json_response({'status': 'ok'}))
    app.router.add_get('/', lambda _: web.json_response({
        'status': 'ok',
        'message': 'Clipboard server running',
        'version': '1.1.0',
        'endpoints': {'ws': '/ws', 'health': '/health', 'hostname': '/hostname'}
    }))
    return app


class ServerManager:
    """Démarre et arrête proprement le serveur."""

    def __init__(self):
        self.server_started = False
        self.loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.loop)

    def run(self):
        try:
            logger.info("🔧 Démarrage du serveur Clipboard...")
            app = self.loop.run_until_complete(create_app())
            self.server_started = True

            runner = web.AppRunner(app)
            self.loop.run_until_complete(runner.setup())
            site = web.TCPSite(runner, '0.0.0.0', 24900)
            self.loop.run_until_complete(site.start())

            logger.info("🚀 Serveur lancé sur http://0.0.0.0:24900")
            logger.info("📡 WebSocket endpoint: ws://0.0.0.0:24900/ws")

            # Gestion propre des signaux
            def shutdown():
                logger.info("👋 Arrêt demandé...")
                for task in asyncio.all_tasks(self.loop):
                    if task is not asyncio.current_task():
                        task.cancel()
                self.loop.create_task(runner.cleanup())
                self.loop.stop()

            for sig in (signal.SIGINT, signal.SIGTERM):
                self.loop.add_signal_handler(sig, shutdown)

            self.loop.run_forever()

        except KeyboardInterrupt:
            logger.info("🧤 Arrêt manuel via Ctrl+C")
        except Exception as e:
            logger.error(f"❌ Erreur serveur: {e}", exc_info=True)
        finally:
            tasks = [t for t in asyncio.all_tasks(self.loop) if not t.done()]
            for t in tasks:
                t.cancel()
            if tasks:
                self.loop.run_until_complete(asyncio.gather(*tasks, return_exceptions=True))
            self.loop.close()
            logger.info("✅ Serveur arrêté proprement")


if __name__ == '__main__':
    ServerManager().run()
