import aiohttp

class Decider:
    def __init__(self,base_url: str, questions: dict) -> None:
        self.base_url = base_url
        self.questions = questions
        self.session = aiohttp.ClientSession(trust_env=True)
    async def query(self,state: dict) -> dict:
        payload = {
            "state": state,
            "questions": self.questions
        }
        async with self.session.post(url=self.base_url,json=payload) as response:
            return (await response.json()).get('answers',{})