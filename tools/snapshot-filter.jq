# jq filter that zeroes known-volatile fields in dashboard API responses so
# back-to-back snapshots (baseline vs after-refactor) compare cleanly.
#
# Anything that's a function of wall-clock time, live origin/main movement,
# or rolling CI state gets stamped to a placeholder. Everything else (PR
# numbers, branch names, titles, statuses, structure) stays.

walk(
  if type == "object" then
    # timestamps / dates
    (if has("generated_at") then .generated_at = "VOLATILE" else . end)
    | (if has("date") then .date = "VOLATILE" else . end)
    | (if has("ts") then .ts = "VOLATILE" else . end)
    | (if has("recs_ts") then .recs_ts = "VOLATILE" else . end)
    | (if has("age_ms") then .age_ms = "VOLATILE" else . end)
    | (if has("now_ms") then .now_ms = "VOLATILE" else . end)
    # relative-time strings the server precomputes for the UI
    | (if has("updated_label") then .updated_label = "VOLATILE" else . end)
    | (if has("age_label") then .age_label = "VOLATILE" else . end)
    # values driven by live git/CI motion
    | (if has("behind_origin") then .behind_origin = "VOLATILE" else . end)
    | (if has("restack_check") then .restack_check = "VOLATILE" else . end)
    | (if has("checks") and (.checks | type) == "object" then .checks = "VOLATILE" else . end)
    | (if has("human_comments") then .human_comments = "VOLATILE" else . end)
    | (if has("bot_comments") then .bot_comments = "VOLATILE" else . end)
  else . end
)
