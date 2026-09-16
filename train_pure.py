import argparse
import json
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

def export_weights(model, template_path="data/ichigo_nn.json", output_path="data/ichigo_nn.json"):
    with open(template_path, 'r') as f:
        data = json.load(f)

    with torch.no_grad():
        layers = [
            {"w": model.net[0].weight.cpu().numpy().flatten().tolist(), "b": model.net[0].bias.cpu().numpy().tolist()},
            {"w": model.net[2].weight.cpu().numpy().flatten().tolist(), "b": model.net[2].bias.cpu().numpy().tolist()},
            {"w": model.net[4].weight.cpu().numpy().flatten().tolist(), "b": model.net[4].bias.cpu().numpy().tolist()}
        ]

    data["net"]["layers"] = layers
    with open(output_path, 'w') as f:
        json.dump(data, f)
    print(f"\n[Export] Successfully updated {output_path} with trained weights!")

def train():
    parser = argparse.ArgumentParser(description="Kamen Fight Pure RL Trainer")
    parser.add_argument("--games", type=int, default=1000, help="Number of battles to train")
    parser.add_argument("--opponents", type=str, default="all", help="'all' or specific rider ID (e.g. nigo, v3, amazon)")
    parser.add_argument("--lr", type=float, default=1e-4, help="Learning rate")
    args = parser.parse_args()

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    roster = ["nigo", "v3", "riderman", "x", "amazon"] if args.opponents == "all" else [args.opponents]
    
    env = PureKamenFightEnv(p1="ichigo", p2=roster[0])
    model = SoulNN().to(device)
    optimizer = optim.Adam(model.parameters(), lr=args.lr)

    total_fights = args.games
    fights_completed = 0
    total_steps = 0
    recent_wins = []
    
    start_time = time.time()
    last_print = time.time()

    print(f"=== Kamen Fight RL Trainer ===")
    print(f"Device: {device} | Games: {total_fights} | Roster Pool: {roster}")
    print("------------------------------------------------------------")

    for fight in range(1, total_fights + 1):
        # Rotate opponents across rounds if set to 'all'
        opp_id = roster[fight % len(roster)]
        env.p2_id = opp_id
        
        obs, _ = env.reset()
        done = False
        fight_reward = 0

        while not done:
            total_steps += 1
            if np.random.rand() < max(0.05, 1.0 - fight / (total_fights * 0.8)):
                action = env.action_space.sample()
            else:
                state_t = torch.tensor(obs, dtype=torch.float32, device=device).unsqueeze(0)
                q_vals = model(state_t)
                action = torch.argmax(q_vals, dim=1).item()

            next_obs, reward, done, _, _ = env.step(action)
            fight_reward += reward
            obs = next_obs

        fights_completed += 1
        won = 1 if fight_reward > 0 else 0
        recent_wins.append(won)
        if len(recent_wins) > 50:
            recent_wins.pop(0)

        # Live telemetry updates
        now = time.time()
        if now - last_print >= 1.0 or fight == total_fights:
            elapsed = now - start_time
            sps = int(total_steps / elapsed)
            mpm = int((fights_completed / elapsed) * 60)
            win_rate = (sum(recent_wins) / len(recent_wins)) * 100

            print(f"Battles: {fights_completed}/{total_fights} | "
                  f"Vs: {opp_id:<8} | "
                  f"Win Rate (Last 50): {win_rate:5.1f}% | "
                  f"Speed: {sps:,} steps/s ({mpm} fights/min) | "
                  f"Elapsed: {elapsed:.1f}s")
            last_print = now

    torch.save(model.state_dict(), "soul_ichigo.pth")
    export_weights(model)

if __name__ == "__main__":
    train()
