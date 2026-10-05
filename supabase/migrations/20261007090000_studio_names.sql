-- =============================================================================
-- Clock-In · Echte Studionamen: Krailling, Germering, Starnberg, Moosach
-- =============================================================================
update public.locations set code = 'KRAILLING', name = 'Studio Krailling' where code = 'NORD';
update public.locations set code = 'GERMERING', name = 'Studio Germering' where code = 'SUED';
update public.locations set code = 'STARNBERG', name = 'Studio Starnberg' where code = 'WEST';
update public.locations set code = 'MOOSACH',   name = 'Studio Moosach'   where code = 'OST';

-- Bereits angelegte Tablets mit altem Namen umbenennen (Benutzername bleibt gleich)
update public.kiosk_devices set name = 'Tablet Krailling' where name = 'Tablet Nord';
update public.kiosk_devices set name = 'Tablet Germering' where name = 'Tablet Süd';
update public.kiosk_devices set name = 'Tablet Starnberg' where name = 'Tablet West';
update public.kiosk_devices set name = 'Tablet Moosach'   where name = 'Tablet Ost';
