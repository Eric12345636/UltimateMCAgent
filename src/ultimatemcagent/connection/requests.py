from typing_extensions import Self

import socket
import asyncio
import aiohttp
import aiodns
from ..ext_file_ops import load_json_from_file
LOGIN_DATA = load_json_from_file('login.json')

BASE_URL = r'http://127.0.0.1:18900/api/v1/'
class HttpRequestHandler:
    _instance = None
    _initialized = False
    def __new__(cls) -> Self:
        if cls._instance:
            return cls._instance
        cls._instance = super().__new__(cls)
        return cls._instance
    def __init__(self) -> None:
        if not self._initialized:
            self.token = ''
            self.headers = {}
            self.session = aiohttp.ClientSession(
BASE_URL,connector=aiohttp.TCPConnector(family=socket.AF_INET),trust_env=True)
        self._initialized = True
    async def __aenter__(self) -> Self:
        return self
    async def __aexit__(self, exc_type, exc, tb) -> None:
        await self.session.close()
    async def login(self) -> None:
        async with self.session.post('auth/login',json=LOGIN_DATA) as response:
            if not response.status == 200:
                print(response.status)
                return
            data: dict = await response.json()
            self.token = data.get('token','')
            print(f'login with token {self.token}')
            self.headers = {'Authorization': f'Bearer {self.token}'}
    async def logout(self) -> None:
        async with self.session.post('auth/logout',headers=self.headers) as response:
            data: dict = await response.json()
            if data.get('ok'):
                print('logout')
    async def connect(self) -> None:
        async with self.session.post('connect',headers=self.headers) as response:
            data: dict = await response.json()
            if data.get('ok'):
                print('connected to server')
    async def disconnect(self) -> None:
        async with self.session.post('disconnect',headers=self.headers) as response:
            data: dict = await response.json()
            if data.get('ok'):
                print('successfully disconnected')
    async def get_data(self,url: str,body: dict | None = None) -> dict | None:
        try:
            async with self.session.get(url,json=body,headers=self.headers) as response:
                data: dict = await response.json()
                if data.get('ok'):
                    print(data)
        except:
            return
    