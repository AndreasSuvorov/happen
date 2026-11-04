-- Kohlenhydrate und Fett zusätzlich zu Protein erfassen.
alter table public.entries
  add column carbs_g int,
  add column fat_g int;
