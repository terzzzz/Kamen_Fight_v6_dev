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

def export_weights(model, output_path="data/wt_ichigo_nn.json"):
    import os
    
    template = None
    for candidate in [output_path, "data/ichigo_nn.json"]:
        if os.path.exists(candidate):
            with open(candidate, 'r') as f:
                template = json.load(f)
            break
            
    if template is None:
        template = {
            "version": "kf-soul-ddqn-v2",
            "spec": {
                "tag": "kf-charge-v2", "step": 50, "decision": 100,
                "reaction": 250, "delay": 250, "history": 4, "gamma": 0.999,
                "roster": ["amazon", "ichigo", "nigo", "riderman", "v3", "x"],
                "buffs": ["accuracy_focus", "airborne_boost", "airborne_evasion", "bleeding",
                          "double_typhoon_speed", "focus", "gigi_focus", "inca_blessing",
                          "mercury_atk", "mercury_def", "power_focus", "red_lamp_boost",
                          "red_shutter", "rope_bind", "typhoon_speed"],
                "input": 476
            },
            "net": {"sizes": [476, 64, 64, 10], "layers": []}
        }

    with torch.no_grad():
        layers = [
            {"w": model.net[0].weight.cpu().numpy().flatten().tolist(), "b": model.net[0].bias.cpu().numpy().tolist()},
            {"w": model.net[2].weight.cpu().numpy().flatten().tolist(), "b": model.net[2].bias.cpu().numpy().tolist()},
            {"w": model.net[4].weight.cpu().numpy().flatten().tolist(), "b": model.net[4].bias.cpu().numpy().tolist()}
        ]

    template["net"]["layers"] = layers
    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
    with open(output_path, 'w') as f:
        json.dump(template, f)
    print(f"\n[Export] Successfully saved trained weights to {output_path}!")

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

    import os
    if os.path.exists("soul_ichigo.pth"):
        model.load_state_dict(torch.load("soul_ichigo.pth", map_location=device))
        print("[Resume] Loaded weights from soul_ichigo.pth!")

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
        opp_id = roster[fight % len(roster)]
        env.p2_id = opp_id
        
        obs, _ = env.reset()
        done = False
        fight_reward = 0

        while not done:
            total_steps += 1
            state_t = torch.tensor(obs, dtype=torch.float32, device=device).unsqueeze(0)

            if np.random.rand() < max(0.05, 1.0 - fight / (total_fights * 0.8)):
                action = env.action_space.sample()
            else:
                with torch.no_grad():
                    q_vals = model(state_t)
                    action = torch.argmax(q_vals, dim=1).item()

            next_obs, reward, done, _, _ = env.step(action)
            fight_reward += reward

            if total_steps % 16 == 0 or done:
                current_q = model(state_t)[0, action]
                with torch.no_grad():
                    next_state_t = torch.tensor(next_obs, dtype=torch.float32, device=device).unsqueeze(0)
                    max_next_q = torch.max(model(next_state_t)) if not done else torch.tensor(0.0, device=device)
                    target_q = reward + 0.999 * max_next_q

                loss = nn.functional.mse_loss(current_q, target_q)
                optimizer.zero_grad()
                loss.backward()
                optimizer.step()

            obs = next_obs

        fights_completed += 1
        won = 1 if fight_reward > 0 else 0
        recent_wins.append(won)
        if len(recent_wins) > 50:
            recent_wins.pop(0)

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
