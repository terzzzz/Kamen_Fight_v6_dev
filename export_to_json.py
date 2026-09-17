import json
import torch

# 1. Load PyTorch model checkpoint
ckpt = torch.load("soul_ichigo.pth", map_location="cpu")
sd = ckpt.get("state_dict", ckpt) if isinstance(ckpt, dict) else ckpt

pt_weights = [v for k, v in sd.items() if "weight" in k]
pt_biases = [v for k, v in sd.items() if "bias" in k]

# 2. Load baseline JSON template structure
with open("data/wt_ichigo_nn.json", "r") as f:
    data = json.load(f)

data["games"] = 7800
net_obj = data.get("net") if "net" in data else data
layers = net_obj["layers"]

# 3. Transpose PyTorch 2D weights (.T) so flat ordering matches JS expectations
for i in range(min(len(layers), len(pt_weights))):
    w_tensor = pt_weights[i]
    if w_tensor.ndim == 2:
        w_tensor = w_tensor.T
        
    layers[i]["w"] = w_tensor.flatten().tolist()
    layers[i]["b"] = pt_biases[i].flatten().tolist()
    layers[i].pop("weights", None)
    layers[i].pop("bias", None)

# 4. Save exclusively to the candidate JSON file
with open("data/wt_ichigo_can_nn.json", "w") as f:
    json.dump(data, f)

print("SUCCESS: Transposed and flattened weights written to data/wt_ichigo_can_nn.json!")