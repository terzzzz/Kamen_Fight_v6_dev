import json
import torch

# 1. Load PyTorch state dict
sd = torch.load("soul_ichigo.pth", map_location="cpu")

# Explicit layer key mapping based on soul_ichigo.pth structure
weight_keys = ["net.0.weight", "net.2.weight", "net.4.weight"]
bias_keys   = ["net.0.bias",   "net.2.bias",   "net.4.bias"]

# 2. Load JSON template structure
with open("data/wt_ichigo_nn.json", "r") as f:
    data = json.load(f)

data["games"] = 7800
net_obj = data.get("net") if "net" in data else data
layers = net_obj["layers"]

# 3. Overwrite all 3 layers explicitly
for idx, (w_key, b_key) in enumerate(zip(weight_keys, bias_keys)):
    w_tensor = sd[w_key]
    b_tensor = sd[b_key]
    
    layers[idx]["w"] = w_tensor.flatten().tolist()
    layers[idx]["b"] = b_tensor.flatten().tolist()
    layers[idx].pop("weights", None)
    layers[idx].pop("bias", None)

# 4. Save to candidate JSON file
with open("data/wt_ichigo_can_nn.json", "w") as f:
    json.dump(data, f)

# 5. Sanity check layer differences against active baseline
active_data = json.load(open("data/wt_ichigo_nn.json"))
active_layers = (active_data.get("net") or active_data)["layers"]

print("=== LAYER-BY-LAYER VERIFICATION ===")
for i in range(len(layers)):
    sum_active = sum(active_layers[i]["w"])
    sum_cand = sum(layers[i]["w"])
    print(f"Layer {i} -> Active sum: {sum_active:.4f} | Candidate sum: {sum_cand:.4f} | Updated?: {sum_active != sum_cand}")

print("\nSUCCESS: Candidate JSON created with true PyTorch weights across all layers!")