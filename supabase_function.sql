-- =====================================================
-- Chạy đoạn SQL này trong Supabase SQL Editor
-- (Dashboard > SQL Editor > New Query > Paste & Run)
-- =====================================================

CREATE OR REPLACE FUNCTION get_hist5m_positive_zones(filter_tf text DEFAULT NULL)
RETURNS TABLE (
  zone_id int,
  start_time timestamptz,
  end_time timestamptz,
  candles int,
  entry_price numeric,
  max_high numeric,
  min_low numeric,
  max_gain numeric,
  max_drop numeric
) AS $$
DECLARE
  rec record;
  prev_hist numeric := -1;
  in_zone boolean := false;
  z_id int := 0;
  z_start timestamptz;
  z_entry numeric;
  z_max_high numeric;
  z_min_low numeric;
  z_candles int;
  z_end timestamptz;
BEGIN
  FOR rec IN
    SELECT r.open_time, r.open, r.high, r.low, r.close,
           r.hist_5m, r.hist_1h, r.hist_4h, r.hist_1d
    FROM "BTCJPY" r
    WHERE r.hist_5m IS NOT NULL
    ORDER BY r.open_time ASC
  LOOP
    -- Detect transition: hist_5m crosses from <=0 to >0
    IF NOT in_zone AND prev_hist <= 0 AND rec.hist_5m > 0 THEN
      -- Apply higher-TF filter at zone entry
      IF filter_tf = '1h' AND (rec.hist_1h IS NULL OR rec.hist_1h <= 0) THEN
        prev_hist := rec.hist_5m;
        CONTINUE;
      END IF;
      IF filter_tf = '4h' AND (rec.hist_4h IS NULL OR rec.hist_4h <= 0) THEN
        prev_hist := rec.hist_5m;
        CONTINUE;
      END IF;
      IF filter_tf = '1d' AND (rec.hist_1d IS NULL OR rec.hist_1d <= 0) THEN
        prev_hist := rec.hist_5m;
        CONTINUE;
      END IF;

      in_zone := true;
      z_id := z_id + 1;
      z_start := rec.open_time;
      z_entry := rec.open;
      z_max_high := rec.high;
      z_min_low := rec.low;
      z_candles := 1;
      z_end := rec.open_time;

    ELSIF in_zone AND rec.hist_5m > 0 THEN
      z_candles := z_candles + 1;
      IF rec.high > z_max_high THEN z_max_high := rec.high; END IF;
      IF rec.low < z_min_low THEN z_min_low := rec.low; END IF;
      z_end := rec.open_time;

    ELSIF in_zone AND rec.hist_5m <= 0 THEN
      zone_id := z_id;
      start_time := z_start;
      end_time := z_end;
      candles := z_candles;
      entry_price := z_entry;
      max_high := z_max_high;
      min_low := z_min_low;
      max_gain := z_max_high - z_entry;
      max_drop := z_entry - z_min_low;
      RETURN NEXT;
      in_zone := false;
    END IF;

    prev_hist := rec.hist_5m;
  END LOOP;

  -- Return last zone if still open
  IF in_zone THEN
    zone_id := z_id;
    start_time := z_start;
    end_time := z_end;
    candles := z_candles;
    entry_price := z_entry;
    max_high := z_max_high;
    min_low := z_min_low;
    max_gain := z_max_high - z_entry;
    max_drop := z_entry - z_min_low;
    RETURN NEXT;
  END IF;
END;
$$ LANGUAGE plpgsql;
