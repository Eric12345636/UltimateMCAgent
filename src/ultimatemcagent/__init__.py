from .connection.requests import HttpRequestHandler
import asyncio
from ultimatemcagent.eventbus import EventBus

def main() -> None:
    asyncio.run(_main())

async def _main():
    event_bus = EventBus()
    async with HttpRequestHandler() as handler:
        await handler.login()
        await handler.connect()
        input()
        await handler.logout()