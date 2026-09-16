 git rebase --abort 2>/dev/null || true
git merge --abort 2>/dev/null || true
git add -A
git commit -m "Restore local trainer and update weights"
git push origin terzzzz-test_adv_train --force
