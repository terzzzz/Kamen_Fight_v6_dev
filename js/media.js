/**
 * Media, Video & Animation Controller
 * Path: js/media.js
 */

/**
 * Native clip facing:
 *   "right" = rider looks toward P2 (P1-native) — Nigo / V3 / Riderman default
 *   "left"  = rider looks toward P1 (P2-native) — Ichigo default
 *
 * Stage:
 *   P1 (left box) must look right
 *   P2 (right box) must look left
 *
 * Priority: move.sourceFacing → player.sourceFacing → rider default
 * moves.json "unmirrored": true = never flip that clip
 */
function getTransformFlip(player, playerKey, moveObj = null) {
  if (moveObj && moveObj.unmirrored === true) {
    return 'scaleX(1)';
  }

  const riderId = String(
    (player && player.id) || (playerKey === 'p1' ? 'ichigo' : 'nigo')
  ).toLowerCase();

  const defaultFacing = (riderId === 'ichigo') ? 'left' : 'right';

  const nativeFacing = (
    (moveObj && moveObj.sourceFacing) ||
    (player && player.sourceFacing) ||
    defaultFacing
  );

  const targetFacing = (playerKey === 'p1') ? 'right' : 'left';
  return (nativeFacing !== targetFacing) ? 'scaleX(-1)' : 'scaleX(1)';
}

// Side Character Video Updater (Idle, Mid-Air, Faint, Victory, KO)
function updateCharacterMedia(playerKey, stateType = 'IDLE') {
  const videoEl = document.getElementById(`${playerKey}-video`);
  const spriteEl = document.getElementById(`${playerKey}-sprite`);
  if (!videoEl) return;

  const player = window.gameState ? window.gameState[playerKey] : null;
  const riderId = (player && player.id) ? player.id : (playerKey === 'p1' ? 'ichigo' : 'nigo');

  let state = String(stateType || 'IDLE').toLowerCase();
  let fileName = state;

  if (state === 'idle') {
    if (player && player.isFainted) {
      fileName = 'faint';
    } else if (player && player.airborneTicks > 0) {
      fileName = 'mid-air';
    } else {
      fileName = 'idle';
    }
  } else if (state === 'victory') {
    fileName = Math.random() < 0.5 ? 'victory' : 'victory2';
  } else if (state === 'ko') {
    fileName = 'ko';
  }

  const cleanFile = fileName.replace(/\.(mp4|webm)$/i, '');

  const videoCandidates = [
    `assets/videos/${riderId}/${cleanFile}.mp4`,
    `assets/videos/${riderId}_${cleanFile}.mp4`,
    `assets/videos/${cleanFile}.mp4`,
    `assets/videos/${riderId}/idle.mp4`,
    `assets/videos/${riderId}_idle.mp4`
  ];

  const imageCandidates = [
    `assets/images/icons/${riderId}.png`,
    `assets/images/${riderId}.png`,
    `assets/images/icons/ichigo.png`
  ];

  videoEl.style.transform = getTransformFlip(player, playerKey);
  videoEl.muted = true;
  videoEl.defaultMuted = true;
  videoEl.playsInline = true;
  videoEl.setAttribute('playsinline', '');
  videoEl.setAttribute('webkit-playsinline', '');

  const isLoopingState = ['idle', 'mid-air', 'faint'].includes(cleanFile);
  videoEl.loop = isLoopingState;

  let candidateIdx = 0;

  function tryNextVideo() {
    if (candidateIdx >= videoCandidates.length) {
      tryImageFallback();
      return;
    }

    const src = videoCandidates[candidateIdx++];

    videoEl.onerror = () => tryNextVideo();
    videoEl.onplaying = () => {
      videoEl.hidden = false;
      videoEl.style.display = 'block';
      if (spriteEl) spriteEl.hidden = true;
    };

    videoEl.src = src;
    videoEl.load();

    const p = videoEl.play();
    if (p !== undefined) {
      p.then(() => {
        videoEl.hidden = false;
        videoEl.style.display = 'block';
        if (spriteEl) spriteEl.hidden = true;
      }).catch(() => tryNextVideo());
    }
  }

  function tryImageFallback() {
    videoEl.hidden = true;
    videoEl.style.display = 'none';
    if (!spriteEl) return;

    let imgIdx = 0;
    function tryNextImg() {
      if (imgIdx >= imageCandidates.length) return;
      const imgSrc = imageCandidates[imgIdx++];
      spriteEl.onerror = () => tryNextImg();
      spriteEl.onload = () => {
        spriteEl.hidden = false;
        spriteEl.style.display = 'block';
      };
      spriteEl.src = imgSrc;
    }
    tryNextImg();
  }

  tryNextVideo();
}

// Action Cutscene Video Player (Center Box)
function playCenterVideo(playerKey, videoFile, actionName = '', maxDurationMs = null, moveObj = null) {
  return new Promise((resolve) => {
    const centerBox = document.getElementById('center-box');
    const centerVid = document.getElementById('center-video');
    const actionLabel = document.getElementById('center-action-label');

    if (!centerBox || !centerVid) {
      resolve();
      return;
    }

    const player = window.gameState ? window.gameState[playerKey] : null;
    const riderId = (player && player.id) ? player.id : (playerKey === 'p1' ? 'ichigo' : 'nigo');

    if (actionLabel) {
      const name = player ? player.name : playerKey.toUpperCase();
      actionLabel.textContent = actionName ? `[${playerKey.toUpperCase()}] ${name} : ${actionName}!` : '';
      actionLabel.hidden = !actionName;
    }

    centerBox.hidden = false;
    centerBox.style.display = 'flex';

    centerVid.muted = true;
    centerVid.defaultMuted = true;
    centerVid.playsInline = true;
    centerVid.setAttribute('playsinline', '');
    centerVid.setAttribute('webkit-playsinline', '');

    centerVid.style.transform = getTransformFlip(player, playerKey, moveObj);

    let resolved = false;
    let fallbackTimer = null;

    const cleanUpAndResolve = () => {
      if (resolved) return;
      resolved = true;
      if (fallbackTimer) clearTimeout(fallbackTimer);

      centerVid.onended = null;
      centerVid.onerror = null;

      centerVid.pause();
      centerVid.style.transform = 'none';
      centerBox.hidden = true;
      centerBox.style.display = 'none';
      if (actionLabel) actionLabel.hidden = true;
      resolve();
    };

    const cleanFileName = String(videoFile || 'idle.mp4').replace(/^assets\/videos\//, '').replace(/\.(mp4|webm)$/i, '');

    const candidates = [
      `assets/videos/${riderId}/${cleanFileName}.mp4`,
      `assets/videos/${riderId}_${cleanFileName}.mp4`,
      `assets/videos/${cleanFileName}.mp4`,
      `assets/videos/${riderId}/idle.mp4`
    ];

    let candidateIdx = 0;

    function tryNextCenterVideo() {
      if (candidateIdx >= candidates.length || resolved) {
        cleanUpAndResolve();
        return;
      }

      const src = candidates[candidateIdx++];

      centerVid.onended = () => cleanUpAndResolve();
      centerVid.onerror = () => tryNextCenterVideo();

      centerVid.src = src;
      centerVid.load();

      const p = centerVid.play();
      if (p !== undefined) {
        p.catch(() => tryNextCenterVideo());
      }
    }

    fallbackTimer = setTimeout(cleanUpAndResolve, maxDurationMs || 8000);
    tryNextCenterVideo();
  });
}

function hideCenterScreen() {
  const centerBox = document.getElementById('center-box');
  const centerVid = document.getElementById('center-video');
  if (centerVid) {
    centerVid.pause();
    centerVid.removeAttribute('src');
    centerVid.style.transform = 'none';
  }
  if (centerBox) {
    centerBox.hidden = true;
    centerBox.style.display = 'none';
  }
}

function unlockMobileVideos() {
  const vids = document.querySelectorAll('video');
  vids.forEach(v => {
    v.muted = true;
    v.playsInline = true;
    const p = v.play();
    if (p !== undefined) {
      p.then(() => v.pause()).catch(() => {});
    }
  });
}

window.getTransformFlip = getTransformFlip;
window.updateCharacterMedia = updateCharacterMedia;
window.playCenterVideo = playCenterVideo;
window.hideCenterScreen = hideCenterScreen;
window.unlockMobileVideos = unlockMobileVideos;

