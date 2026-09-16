import subprocess
import json
import numpy as np
import gymnasium as gym
from gymnasium import spaces

class KamenFightEnv(gym.Env):
    def __init__(self, node_script="engine_ipc.js", p1="ichigo", p2="nigo"):
        super(KamenFightEnv, self).__init__()
        
        self.action_space = spaces.Discrete(10)
        self.observation_space = spaces.Box(low=-1.0, high=1.0, shape=(476,), dtype=np.float32)
        
        self.p1 = p1
        self.p2 = p2
        self.proc = subprocess.Popen(
            ["node", node_script],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1
        )

    def _send_recv(self, payload):
        self.proc.stdin.write(json.dumps(payload) + "\n")
        self.proc.stdin.flush()
        response_line = self.proc.stdout.readline()
        return json.loads(response_line)

    def reset(self, seed=None, options=None):
        super().reset(seed=seed)
        seed_val = seed if seed is not None else np.random.randint(0, 1000000)
        
        res = self._send_recv({
            "cmd": "reset",
            "p1": self.p1,
            "p2": self.p2,
            "seed": seed_val
        })
        
        obs = np.array(res["obs"], dtype=np.float32)
        return obs, {}

    def step(self, action):
        res = self._send_recv({
            "cmd": "step",
            "action": int(action)
        })
        
        obs = np.array(res["obs"], dtype=np.float32)
        reward = float(res["reward"])
        done = bool(res["done"])
        
        return obs, reward, done, False, {}

    def close(self):
        if self.proc:
            self.proc.terminate()

# Test runner
if __name__ == "__main__":
    env = KamenFightEnv()
    obs, info = env.reset(seed=42)
    print(f"Initial observation shape: {obs.shape}")
    
    total_reward = 0
    done = False
    steps = 0
    
    while not done and steps < 100:
        action = env.action_space.sample() # Random action (0-9)
        obs, reward, done, truncated, info = env.step(action)
        total_reward += reward
        steps += 1
        
    print(f"Finished episode in {steps} steps with total reward: {total_reward}")
    env.close()
