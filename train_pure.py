import time
import torch
import torch.nn as nn
import torch.optim as optim
import numpy as np
from kamen_env_pure import PureKamenFightEnv

class SoulNN(nn.Module):
    def __init__(self, input_dim=476, hidden_dim=64, num_actions=10):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(input_dim, hidden_dim),
            nn.ReLU(),
            nn.Linear(hidden_dim, hidden_dim),
            nn.ReLU(),
            nn.Linear(hidden_dim, num_actions)
        )

    def forward(self, x):
        return self.net(x)

def train():
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    env = PureKamenFightEnv()
    model = SoulNN().to(device)
    optimizer = optim.Adam(model.parameters(), lr=1e-4)
    
    total_fights = 1000
    fights_completed = 0
    total_steps = 0
    wins = 0
    
    start_time = time.time()
    last_print = time.time()
    
    print(f"=== Starting Kamen Fight Pure Python RL Trainer on [{device}] ===")

    for fight in range(1, total_fights + 1):
        obs, _ = env.reset()
        done = False
        fight_reward = 0
        
        while not done:
            total_steps += 1
            
            # Epsilon-greedy action policy selection
            if np.random.rand() < 0.1:
                action = env.action_space.sample()
            else:
                state_t = torch.tensor(obs, dtype=torch.float32, device=device).unsqueeze(0)
                q_vals = model(state_t)
                action = torch.argmax(q_vals, dim=1).item()

            next_obs, reward, done, _, _ = env.step(action)
            fight_reward += reward
            obs = next_obs

        fights_completed += 1
        if fight_reward > 0:
            wins += 1

        # Print screen telemetry per second
        now = time.time()
        if now - last_print >= 1.0 or fight == total_fights:
            elapsed = now - start_time
            sps = int(total_steps / elapsed)
            win_rate = (wins / fights_completed) * 100
            
            print(f"Fights: {fights_completed}/{total_fights} | "
                  f"Win Rate: {win_rate:.1f}% | "
                  f"Speed: {sps:,} steps/sec | "
                  f"Total Steps: {total_steps:,} | "
                  f"Elapsed: {elapsed:.1f}s")
            
            last_print = now

    print("\nTraining Finished Successfully!")

if __name__ == "__main__":
    train()
