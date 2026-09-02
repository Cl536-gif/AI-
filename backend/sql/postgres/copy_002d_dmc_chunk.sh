#!/bin/zsh
set -euo pipefail

script_dir="${0:A:h}"
source_sql="$script_dir/002d_identity_merge_verify.review.sql"
chunk="${1:-}"

copy_literal_chunk() {
  local run_name="$1"
  local sequence="$2"
  local first_line="$3"
  local last_line="$4"

  {
    printf "INSERT INTO pg_temp.dmc_002d_sql_parts(run_name, sequence, sql_part) VALUES ('%s', %s, \u0024dmc002d\u0024\n" "$run_name" "$sequence"
    sed -n "${first_line},${last_line}p" "$source_sql"
    printf '\u0024dmc002d\u0024);\n'
  } | pbcopy
}

case "$chunk" in
  setup)
    printf '%s\n' \
      'DROP TABLE IF EXISTS pg_temp.dmc_002d_sql_parts;' \
      'CREATE TEMP TABLE pg_temp.dmc_002d_sql_parts (' \
      '  run_name text NOT NULL,' \
      '  sequence integer NOT NULL,' \
      '  sql_part text NOT NULL,' \
      '  PRIMARY KEY (run_name, sequence)' \
      ');' | pbcopy
    ;;
  a1) copy_literal_chunk structure 1 5 150 ;;
  a2) copy_literal_chunk structure 2 151 290 ;;
  a3) copy_literal_chunk structure 3 291 429 ;;
  final1) copy_literal_chunk final 1 1484 1580 ;;
  final2) copy_literal_chunk final 2 1581 1680 ;;
  final3) copy_literal_chunk final 3 1681 1764 ;;
  run-a)
    printf '%s\n' \
      'DROP TABLE IF EXISTS pg_temp.dmc_002d_structure_results;' \
      'DO $transport$' \
      'DECLARE' \
      '  statement_text text;' \
      'BEGIN' \
      "  SELECT string_agg(sql_part, '' ORDER BY sequence)" \
      '  INTO statement_text' \
      '  FROM pg_temp.dmc_002d_sql_parts' \
      "  WHERE run_name = 'structure';" \
      "  EXECUTE 'CREATE TEMP TABLE pg_temp.dmc_002d_structure_results AS ' || statement_text;" \
      'END' \
      '$transport$;' \
      'SELECT item, status, details' \
      'FROM pg_temp.dmc_002d_structure_results' \
      'ORDER BY item;' \
      'SELECT' \
      '  COUNT(*) AS total_checks,' \
      "  COUNT(*) FILTER (WHERE status = 'PASS') AS pass_checks," \
      "  COUNT(*) FILTER (WHERE status <> 'PASS') AS fail_checks," \
      "  COALESCE(string_agg(item, ', ' ORDER BY item) FILTER (WHERE status <> 'PASS'), 'none') AS failed_items" \
      'FROM pg_temp.dmc_002d_structure_results;' | pbcopy
    ;;
  b1) sed -n '432,700p' "$source_sql" | pbcopy ;;
  b2) sed -n '701,949p' "$source_sql" | pbcopy ;;
  b3) sed -n '950,1275p' "$source_sql" | pbcopy ;;
  b4) sed -n '1276,1483p' "$source_sql" | pbcopy ;;
  finish-b)
    printf '%s\n' \
      'DO $transport$' \
      'DECLARE' \
      '  statement_text text;' \
      'BEGIN' \
      "  SELECT string_agg(sql_part, '' ORDER BY sequence)" \
      '  INTO statement_text' \
      '  FROM pg_temp.dmc_002d_sql_parts' \
      "  WHERE run_name = 'final';" \
      "  EXECUTE 'CREATE TEMP TABLE pg_temp.dmc_002d_final_result AS ' || statement_text;" \
      'END' \
      '$transport$;' \
      'SELECT * FROM pg_temp.dmc_002d_final_result;' \
      'ROLLBACK;' | pbcopy
    ;;
  cleanup)
    printf '%s\n' \
      'DROP TABLE IF EXISTS pg_temp.dmc_002d_structure_results;' \
      'DROP TABLE IF EXISTS pg_temp.dmc_002d_final_result;' \
      'DROP TABLE IF EXISTS pg_temp.dmc_002d_sql_parts;' | pbcopy
    ;;
  *)
    print -u2 'usage: zsh copy_002d_dmc_chunk.sh {setup|a1|a2|a3|final1|final2|final3|run-a|b1|b2|b3|b4|finish-b|cleanup}'
    exit 64
    ;;
esac

print "Copied 002d DMC chunk: $chunk"
