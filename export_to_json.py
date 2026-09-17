import json
import torch

# 1. Load PyTorch checkpoint
checkpoint = torch.load("soul_ichigo.pth", map_location="cpu")
state_dict = checkpoint.get("state_dict", checkpoint) if isinstance(checkpoint, dict) else checkpoint

# 2. Load baseline JSON
with open("data/wt_ichigo_nn.json", "r") as f:
    data = json.load(f)

# 3. Update metadata
data["games"] = 7800

# 4. Extract weights & biases from PyTorch state dict in order
pt_weights = [v for k, v in state_dict.items() if "weight" in k]
pt_biases = [v for k, v in state_dict.items() if "bias" in k]

# 5. Populate JSON layers with FLATTENED 1D arrays
net_obj = data["net"] if "net" in data else data
layers = net_obj["layers"]

for i in range(min(len(layers), len(pt_weights))):
    # .flatten() converts 2D matrix [m, n] into flat 1D array [n * m]
    w_flat = pt_weights[i].flatten().tolist()
    b_flat = pt_biases[i].flatten().tolist()
    
    # Update strictly using 'w' and 'b' keys
    layers[i]["w"] = w_flat
    layers[i]["b"] = b_flat
    
    # Remove any legacy alternative key names
    layers[i].pop("weights", None)
    layers[i].pop("bias", None)

# 6. Save updated JSON
with open("data/wt_ichigo_can_nn.json", "w") as f:
    json.dump(data, f)

print(f"SUCCESS: Flattened {len(layers)} layers into 1D arrays for js/neural_core.js!")