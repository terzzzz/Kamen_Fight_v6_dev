/**
 * Overwrites data/wt_ichigo.json in your GitHub repository via API.
 * 
 * @param {string} repoOwner - Your GitHub username (e.g. "terzzzz")
 * @param {string} repoName  - Your repository name (e.g. "kamen-fight")
 * @param {string} token     - GitHub Personal Access Token (PAT with 'repo' contents write scope)
 */
async function syncWeightsToGitHub(repoOwner, repoName, token) {
  const path = 'data/wt_ichigo.json';
  const apiUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/contents/${path}`;

  console.log('[AgentIchigo] Connecting to GitHub repo API...');

  try {
    // 1. Fetch current file metadata to retrieve its SHA hash (required by GitHub API to overwrite)
    let sha = '';
    const getRes = await fetch(apiUrl, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (getRes.ok) {
      const fileData = await getRes.json();
      sha = fileData.sha;
    }

    // 2. Format weight JSON payload
    const payload = {
      version: '2.0-NN',
      exportedAt: new Date().toISOString(),
      featureNames: FEATURE_KEYS,
      policies: activePolicyStore
    };
    const jsonString = JSON.stringify(payload, null, 2);

    // 3. Base64 encode string for GitHub API compatibility
    const base64Content = btoa(unescape(encodeURIComponent(jsonString)));

    // 4. Send PUT request to overwrite data/wt_ichigo.json
    const putRes = await fetch(apiUrl, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: '🤖 Auto-update evolved weights: data/wt_ichigo.json',
        content: base64Content,
        sha: sha || undefined
      })
    });

    if (putRes.ok) {
      console.log('✅ Overwritten data/wt_ichigo.json directly in GitHub repository!');
      return true;
    } else {
      const errData = await putRes.json();
      console.error('❌ GitHub Sync Failed:', errData.message);
      return false;
    }
  } catch (err) {
    console.error('❌ GitHub Network Error:', err);
    return false;
  }
}

// Attach function to window object
window.AgentIchigo.syncWeightsToGitHub = syncWeightsToGitHub;
