from .connection.requests import HttpRequestHandler
import asyncio

def main() -> None:
    asyncio.run(_main())

async def _main():
    async with HttpRequestHandler() as handler:
        await handler.login()
        await asyncio.sleep(1)
        await handler.logout()