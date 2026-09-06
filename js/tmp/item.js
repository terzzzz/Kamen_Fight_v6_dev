let itemState = {
  activeCenterItem: null,
  itemPool: []
};

async function initItemPool() {
  const response = await fetch('data/items.json');
  itemState.itemPool = await response.json();
}

function checkItemSpawn(turnCounter) {
  if (turnCounter % 5 === 0 && !itemState.activeCenterItem && itemState.itemPool.length > 0) {
    const randomIndex = Math.floor(Math.random() * itemState.itemPool.length);
    itemState.activeCenterItem = itemState.itemPool[randomIndex];
    document.getElementById('item-display').textContent = itemState.activeCenterItem.name;
    document.getElementById('item-display').classList.remove('empty-item');
  }
}

function resolveItemPickup(p1Winner, p2Winner, p1State, p2State) {
  if (!itemState.activeCenterItem) return;

  if (p1Winner && !p2Winner) {
    applyItemEffect(p1State, p2State, itemState.activeCenterItem);
    clearCenterItem();
  } else if (p2Winner && !p1Winner) {
    applyItemEffect(p2State, p1State, itemState.activeCenterItem);
    clearCenterItem();
  }
}

function applyItemEffect(winner, loser, item) {
  if (item.type === 'HEAL_LP') {
    winner.lp = Math.min(winner.maxLp, winner.lp + item.value);
  } else if (item.type === 'GAIN_CHI') {
    winner.chi = Math.min(20, winner.chi + item.value);
  } else if (item.type === 'BUFF_ATK') {
    winner.atkBuff = item.value;
  } else if (item.type === 'DRAIN_CHI') {
    loser.chi = Math.max(0, loser.chi - item.value);
  }
}

function clearCenterItem() {
  itemState.activeCenterItem = null;
  const itemDisplay = document.getElementById('item-display');
  itemDisplay.textContent = 'NO ITEM';
  itemDisplay.classList.add('empty-item');
}
