from threading import Thread
import asyncio
import inspect
from dataclasses import dataclass,field
from enum import Enum
from typing import Callable,Any,Literal
from typing_extensions import Self
from threading import Event,Lock
import traceback
from ultimatemcagent.objects.base import Waypoint
DEBUG = False
# 定义所有可能的事件名
EventName = Literal[
    "decisions.make"
]
@dataclass
class Endpoint:
    namespace: str
    thread: Thread
    loop: asyncio.AbstractEventLoop
    callbacks: dict[str,Callable] = field(default_factory=dict)
    lock: asyncio.Lock | None = None
class EventBus:
    _instance = None
    _initialized = False
    def __new__(cls) -> Self:
        if cls._instance:
            return cls._instance
        cls._instance = super().__new__(cls)
        return cls._instance
    def __init__(self) -> None:
        if not self._initialized:
            self.stopped = Event()
            self.shared = self._Shared()
            self.endpoints: dict[str,Endpoint] = {}
            self._waited_events = []
            self._lock = Lock()
        self._initialized = True
    def add_endpoint(self, namespace: str, lock = False) -> asyncio.AbstractEventLoop:
        """
        注册一个eventbus endpoint，返回该endpoint专用的事件循环
        """
        if namespace in self.endpoints:
            return self.endpoints[namespace].loop
        loop = asyncio.new_event_loop()
        thread = Thread(target=loop.run_forever,daemon=True,name=namespace)
        thread.start()
        if lock:
            endpoint = Endpoint(namespace,thread,loop,lock=asyncio.Lock())
        else:
            endpoint = Endpoint(namespace,thread,loop)
        self.endpoints[namespace] = endpoint
        if DEBUG:
            print(f"ENDPOINT ADDED: {namespace}")
        return loop
    def set_callback(self, namespace: str, event: EventName, callback: Callable) -> bool:
        """
        设置一个事件的回调函数
        """
        if DEBUG:
            print(f"set callback: {namespace} - {callback.__name__}")
        if not namespace in self.endpoints:
            return False
        self.endpoints[namespace].callbacks[event] = callback
        return True
    def remove_callback(self, namespace: str, event: EventName) -> bool:
        """
        删除回调函数
        """
        if not namespace in self.endpoints:
            return False
        if not event in self.endpoints[namespace].callbacks:
            return False
        del self.endpoints[namespace].callbacks[event]
        return True
    def emit(self, event: EventName, payload: Any = None, after: Callable | None = None, timeout: int | None = 15) -> bool:
        """
        发射事件，可指定after
        """
        if DEBUG:
            print(f"[eventbus]{event}")
        if not after:
            for ep in self.endpoints.values():
                cb = ep.callbacks.get(event)
                if cb is None:
                    continue
                ep.loop.call_soon_threadsafe(
                    lambda ep=ep, cb=cb: ep.loop.create_task(
                        self._call_maybe_async(cb, payload,lock=ep.lock, timeout=timeout)))
        else:
            ev = Event()
            for ep in self.endpoints.values():
                cb = ep.callbacks.get(event)
                if cb is None:
                    continue
                ep.loop.call_soon_threadsafe(
                    lambda ep=ep, cb=cb: ep.loop.create_task(
                        self._call_maybe_async(cb, payload, ev,lock=ep.lock,timeout=timeout)))
            after()
        return True
    @staticmethod
    async def _call_maybe_async(func: Callable[..., None] | None, payload: Any = None, ev: Event | None = None, 
                                lock: asyncio.Lock | None = None, timeout: int | None = 15) -> None:
        if not func:
            return
        if lock:
            await lock.acquire()
        try:
            if inspect.iscoroutinefunction(func):
                if payload:
                    future = func(payload)
                else:
                    future = func()
            else:
                if payload:
                    future = asyncio.get_running_loop().run_in_executor(None,lambda: func(payload))
                else:
                    future = asyncio.get_running_loop().run_in_executor(None,lambda: func())
            if timeout:
                await asyncio.wait_for(future,timeout)
            else:
                await future
        except TimeoutError:
            print("TIME OUT")
        except Exception as e:
            print(f"\033[31mUNCAUGHT EXCEPTION: {e}\033[0m")
            traceback.print_exc()
        finally:
            if lock:
                lock.release()
            if ev:
                ev.set()
    
    class _Shared:
        def __init__(self) -> None:
            self.game = self._Game()
        class _Game:
            def __init__(self) -> None:
                self.waypoints: list[Waypoint] = []