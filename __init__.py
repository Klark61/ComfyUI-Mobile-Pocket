import logging

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
WEB_DIRECTORY = "./web/ext"
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

try:
    import folder_paths
    from server import PromptServer

    from .pocket import server_routes

    def _history(limit):
        return PromptServer.instance.prompt_queue.get_history(max_items=limit)

    def _history_item(pid):
        return PromptServer.instance.prompt_queue.get_history(prompt_id=pid)

    server_routes.register(PromptServer.instance.routes,
                           folder_paths.get_output_directory(),
                           folder_paths.get_user_directory(),
                           history_getter=_history,
                           history_item_getter=_history_item)
except Exception:
    logging.exception("[pocket] failed to register routes; continuing without Pocket UI")

try:
    from server import PromptServer as _PS

    from .pocket import mirror

    mirror.install(_PS.instance)
except Exception:
    logging.exception("[pocket] event mirror not installed")
