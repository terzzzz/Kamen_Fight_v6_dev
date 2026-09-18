import json
import numpy as np
import gymnasium as gym
from gymnasium import spaces

ROSTER = ["amazon", "ichigo", "nigo", "riderman", "v3", "x"]
BUFFS = [
    "accuracy_focus", "airborne_boost", "airborne_evasion", "bleeding",
    "double_typhoon_speed", "focus", "gigi_focus", "inca_blessing",
    "mercury_atk", "mercury_def", "power_focus", "red_lamp_boost",
    "red_shutter", "rope_bind", "typhoon_speed"
]

class PureKamenFightEnv(gym.Env):
    def __init__(self, moves_path="data/moves.json", riders_path="data/riders.json", p1="ichigo", p2="nigo"):
        super().__init__()
        
        with open(moves_path, 'r') as f:
            self.raw_moves = json.load(f)
        with open(riders_path, 'r') as f:
            self.riders = {r['id']: r for r in json.load(f) if r.get('active', True)}

        self.p1_id = p1
        self.p2_id = p2
        
        self.action_space = spaces.Discrete(10)
        self.observation_space = spaces.Box(low=-3.0, high=3.0, shape=(476,), dtype=np.float32)
        
        self.reset()

    def reset(self, seed=None, options=None):
        super().reset(seed=seed)
        self.np_rng = np.random.default_rng(seed)
        
        # Fighter Vitals Initialization
        self.p1 = self._create_fighter(self.p1_id)
        self.p2 = self._create_fighter(self.p2_id)
        
        self.round = 1
        self.time_ms = 0
        self.winner = None
        
        # Frame History Queue (4 x 119 = 476)
        single_frame = self._extract_119_frame("p1")
        self.frame_buffer = [single_frame.copy() for _ in range(4)]
        
        return self._get_obs(), {}

    def _create_fighter(self, rider_id):
        r = self.riders[rider_id]
        return {
            "id": rider_id, "maxLp": r["maxLp"], "lp": r["maxLp"],
            "chi": 8, "maxChi": 16, "faintMeter": 0, "isFainted": False,
            "activeBuffs": [], "airborneTicks": 0, "idleStreak": 0
        }

    def _extract_119_frame(self, slot):
        v = []
        p1, p2 = (self.p1, self.p2) if slot == "p1" else (self.p2, self.p1)
        
        # 1. Roster One-Hots (12 dims)
        for rid in ROSTER: v.append(1.0 if p1["id"] == rid else 0.0)
        for rid in ROSTER: v.append(1.0 if p2["id"] == rid else 0.0)

        # 2. Vitals (14 dims)
        v.extend([
            p1["lp"] / p1["maxLp"], p1["lp"] / 3500.0, p1["chi"] / 16.0, p1["faintMeter"] / 100.0,
            float(p1["isFainted"]), p1["airborneTicks"] / 8.0, p1["idleStreak"] / 10.0,
            p2["lp"] / p2["maxLp"], p2["lp"] / 3500.0, p2["chi"] / 16.0, p2["faintMeter"] / 100.0,
            float(p2["isFainted"]), p2["airborneTicks"] / 8.0, p2["idleStreak"] / 10.0
        ])

        # 3. Buff Trays (30 dims)
        for b_id in BUFFS:
            b = next((x for x in p1["activeBuffs"] if x["id"] == b_id), None)
            v.append(b["roundsLeft"] / 8.0 if b else 0.0)
        for b_id in BUFFS:
            b = next((x for x in p2["activeBuffs"] if x["id"] == b_id), None)
            v.append(b["roundsLeft"] / 8.0 if b else 0.0)

        # 4. Action Mask & Move Attributes (60 dims)
        # Pad remaining dimensions to strictly meet 119 features
        pad_len = 119 - len(v)
        v.extend([0.0] * pad_len)
        
        return np.array(v, dtype=np.float32)

    def _get_obs(self):
        return np.concatenate(self.frame_buffer, axis=0)

    def step(self, action):
        # Advance 50ms internal simulation micro-ticks
        self.time_ms += 50
        
        # Execute turn resolution when micro-charge completes (8000ms round limit)
        reward = 0.0
        done = False
        
        if self.time_ms >= 8000:
            self.time_ms = 0
            self.round += 1
            
            # Simple Damage Calculation Example
            p1_dmg = self.np_rng.integers(50, 300) if action in [1,2,3,4,5,6] else 0
            p2_dmg = self.np_rng.integers(50, 250)
            
            self.p2["lp"] = max(0, self.p2["lp"] - p1_dmg)
            self.p1["lp"] = max(0, self.p1["lp"] - p2_dmg)
            
            reward = (p1_dmg - p2_dmg) / 1000.0
            
            if self.p1["lp"] == 0 or self.p2["lp"] == 0 or self.round >= 50:
                done = True
                if self.p1["lp"] > self.p2["lp"]: reward += 1.0
                elif self.p2["lp"] > self.p1["lp"]: reward -= 1.0

        # Push frame to buffer
        self.frame_buffer.pop(0)
        self.frame_buffer.append(self._extract_119_frame("p1"))

        return self._get_obs(), reward, done, False, {}
