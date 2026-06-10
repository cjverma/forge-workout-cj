#!/bin/bash
# Downloads exercise demo clips from MuscleWiki into demos/ and writes demos/map.json.
# Run from the repo root on your Mac:  bash scripts/download-demos.sh
# Then:  git add demos && git commit -m "Add demo clips" && git push

set -u
CDN="https://media.musclewiki.com/media/uploads/videos/branded"
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"
mkdir -p demos

# "Exercise Name|candidate1|candidate2|..."  (candidates are male-<eq>-<slug>, view suffix tried automatically)
EXERCISES=(
  "Seated Cable Row|machine-seated-cable-row"
  "Chest Press Machine|machine-chest-press|machine-seated-chest-press"
  "Incline Chest Press Machine|machine-incline-chest-press"
  "Pec Fly Machine|machine-pec-fly|machine-seated-pec-fly|machine-butterfly|machine-chest-fly"
  "Rear Delt Fly Machine|machine-reverse-fly|machine-rear-delt-fly|machine-seated-reverse-fly"
  "Chest Supported Row|machine-chest-supported-row|machine-seal-row|dumbbells-chest-supported-row"
  "Tricep Extension Machine|machine-tricep-extension|machine-seated-dip|machine-tricep-dip"
  "Preacher Curl Machine|machine-preacher-curl|dumbbells-preacher-curl|barbell-preacher-curl"
  "Leg Press Machine|machine-sled-45-leg-press|machine-leg-press|machine-horizontal-leg-press|machine-sled-leg-press"
  "Seated Leg Curl|machine-seated-leg-curl|machine-hamstring-curl|machine-leg-curl|machine-lying-leg-curl"
  "Leg Extension Machine|machine-leg-extension|machine-seated-leg-extension"
  "Seated Calf Raise|machine-seated-calf-raise|machine-calf-raise|barbell-seated-calf-raise"
  "Hip Abduction Machine|machine-hip-abduction|machine-seated-hip-abduction"
  "Hip Adduction Machine|machine-hip-adduction|machine-seated-hip-adduction"
  "Glute Kickback Machine|machine-glute-kickback|cables-glute-kickback|machine-kickback"
  "Neutral Grip Lat Pulldown|cables-lat-pulldown|machine-lat-pulldown|cables-close-grip-lat-pulldown|cables-neutral-grip-lat-pulldown"
  "Straight Arm Pulldown|cables-straight-arm-pulldown|cables-straight-arm-pushdown"
  "Low Cable Row|cables-seated-row|cables-low-row|machine-seated-cable-row"
  "Cable Tricep Pushdown|cables-tricep-pushdown|cables-push-down|cables-pushdown|cables-tricep-extension"
  "Cable Tricep Pushdown (Rope)|cables-rope-pushdown|cables-tricep-rope-pushdown|cables-tricep-pushdown"
  "Cable Bicep Curl|cables-bicep-curl|cables-curl|cables-cable-curl"
  "Dumbbell Row|dumbbells-bent-over-row|dumbbells-row|dumbbells-single-arm-row|dumbbells-row-unilateral"
  "Seated Dumbbell Curl|dumbbells-seated-bicep-curl|dumbbells-bicep-curl|dumbbells-seated-curl|dumbbells-curl"
  "Hammer Curl|dumbbells-hammer-curl|dumbbells-seated-hammer-curl"
  "Concentration Curl|dumbbells-concentration-curl"
  "Reverse Curl|dumbbells-reverse-curl|barbell-reverse-curl"
  "Incline Dumbbell Fly|dumbbells-incline-fly|dumbbells-incline-chest-fly|dumbbells-fly"
  "Seated External Rotation|dumbbells-external-rotation|dumbbells-seated-external-rotation|cables-external-rotation"
  "Seated Wrist Curl|dumbbells-wrist-curl|dumbbells-seated-wrist-curl|barbell-wrist-curl"
  "Seated Lateral Raise|dumbbells-lateral-raise|dumbbells-seated-lateral-raise"
)

echo "{" > demos/map.json
first=1
found=0
missed=0

for entry in "${EXERCISES[@]}"; do
  IFS='|' read -ra parts <<< "$entry"
  name="${parts[0]}"
  hit=""
  for cand in "${parts[@]:1}"; do
    for view in front side; do
      url="$CDN/male-$cand-$view.mp4"
      # Ranged GET (1 byte) — HEAD is sometimes blocked
      code=$(curl -s -o /dev/null -w "%{http_code}" -A "$UA" -r 0-0 --max-time 15 "$url")
      if [ "$code" = "206" ] || [ "$code" = "200" ]; then
        file="demos/$(echo "$name" | tr 'A-Z ' 'a-z-' | tr -cd 'a-z0-9-').mp4"
        echo "  ✓ $name  ←  male-$cand-$view.mp4"
        curl -s -A "$UA" --max-time 120 -o "$file" "$url"
        hit="$file"
        break 2
      fi
    done
  done
  if [ -n "$hit" ]; then
    [ $first -eq 0 ] && echo "," >> demos/map.json
    printf '  "%s": "%s"' "$name" "$hit" >> demos/map.json
    first=0
    found=$((found+1))
  else
    echo "  ✗ $name — no clip found"
    missed=$((missed+1))
  fi
done

echo "" >> demos/map.json
echo "}" >> demos/map.json

echo ""
echo "Done: $found downloaded, $missed not found."
echo "Size: $(du -sh demos | cut -f1)"
echo ""
echo "Next:  git add demos && git commit -m 'Add exercise demo clips' && git push"
