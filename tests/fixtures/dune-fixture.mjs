// A small stand-in for the Dune game database: the tables and columns the sandbox edition reads
// (see sandbox/sql.js), with a few synthetic players, vehicles, a base and markers. Used by the SQL
// tests and by the end-to-end test (served to the real console through a Postgres socket).
import { PGlite } from '@electric-sql/pglite';

const xf = (x, y, z, qz = 0, qw = 1) => `row(row(${x}, ${y}, ${z}), row(0, 0, ${qz}, ${qw}))::dune.xform`;

export const SCHEMA = `
create schema dune;
create type dune.vec3 as (x double precision, y double precision, z double precision);
create type dune.quat as (x double precision, y double precision, z double precision, w double precision);
create type dune.xform as (location dune.vec3, rotation dune.quat);
create table dune.actors (id bigint primary key, class text, map text, partition_id int, transform dune.xform, owner_account_id bigint, state text);
create table dune.player_state (player_pawn_id bigint, character_name text, online_status text, account_id bigint);
create table dune.world_partition (partition_id int primary key, map text, server_id text, label text, dimension_index int, blocked boolean);
create table dune.farm_state (server_id text, alive boolean, ready boolean, connected_players int);
create table dune.vehicles (id bigint primary key);
create table dune.permission_actor (actor_id bigint, actor_name text);
create table dune.permission_actor_rank (permission_actor_id bigint, player_id bigint, rank int);
create table dune.buildings (id bigint primary key);
create table dune.building_instances (building_id bigint, instance_id int, building_type text, transform double precision[], owner_entity_id bigint);
create table dune.actor_fgl_entities (entity_id bigint, actor_id bigint);
create table dune.base_backup_linked_actors (id bigint, actor_id bigint);
create table dune.placeables (id bigint primary key, building_type text, owner_entity_id bigint, is_hologram boolean);
create table dune.inventories (id bigint primary key, actor_id bigint);
create table dune.items (id bigint primary key, inventory_id bigint);
create table dune.map_names (map_name_id int primary key, map_name text);
create table dune.markers (marker_hash_id bigint primary key, marker_type text, map_name_id int, position dune.vec3);
`;

export const DATA = `
insert into dune.world_partition values (1, 'Survival_1', 'srv1', 'PvE Hagga', 1, false), (8, 'DeepDesert_1', 'srv8', 'Deep Desert', 1, false), (2, 'Overmap', 'srv2', 'Overmap', 1, false);
insert into dune.farm_state values ('srv1', true, true, 2), ('srv8', true, true, 0), ('srv2', true, true, 0);

-- players: two on Hagga Basin (one online, one offline), one in the Deep Desert
insert into dune.actors values
  (101, 'BP_PlayerPawn', 'Survival_1', 1, ${xf(-12000, 8000, 5000)}, 5, null),
  (102, 'BP_PlayerPawn', 'Survival_1', 1, ${xf(30000, -20000, 6000)}, 6, null),
  (103, 'BP_PlayerPawn', 'DeepDesert_1', 8, ${xf(-500000, 600000, 1000)}, 7, null);
insert into dune.player_state values (101, 'Anna Atreides', 'Online', 5), (102, 'Boris Harkonnen', 'Offline', 6), (103, 'Chani Sietch', 'Online', 7);

-- vehicles: a buggy owned by Anna, an ornithopter nobody owns, a stored one (must not appear)
insert into dune.actors values
  (201, 'BP_Buggy_Vehicle_C', 'Survival_1', 1, ${xf(-11000, 8500, 4000)}, null, 'Default'),
  (202, 'BP_LightOrnithopter_C', 'Survival_1', 1, ${xf(40000, 10000, 9000)}, null, 'Default'),
  (203, 'BP_Sandbike_C', 'Survival_1', 1, ${xf(0, 0, 0)}, null, 'VehicleBackup');
insert into dune.vehicles values (201), (202), (203);
insert into dune.permission_actor_rank values (201, 101, 1);

-- a base (claim actor 301) with three pieces, one placeable and a storage container
insert into dune.actors values
  (301, 'BP_TotemSmall_C', 'Survival_1', 1, ${xf(-9000, 9000, 4500)}, null, null),
  (401, 'BP_Container', 'Survival_1', 1, ${xf(-9100, 9050, 4500, 0.7071, 0.7071)}, null, null);
insert into dune.permission_actor values (301, 'Anna Outpost');
insert into dune.permission_actor_rank values (301, 101, 1);
insert into dune.buildings values (1001), (1002);
insert into dune.actor_fgl_entities values (9001, 301);
insert into dune.building_instances values
  (1001, 1, 'Foundation_Choam', array[-9000, 9000, 4500, 0, 0, 0, 1], 9001),
  (1001, 2, 'Wall_Choam', array[-8800, 9000, 4600, 0, 0, 0.7071, 0.7071], 9001),
  (1002, 1, 'Roof_Choam', array[-8800, 9200, 4800, 0, 0, 0, 1], 9001);
insert into dune.placeables values (401, 'StorageContainer_Placeable', 9001, false);
insert into dune.inventories values (1, 401);
insert into dune.items values (1, 1), (2, 1), (3, 1);

-- markers
insert into dune.map_names values (1, 'Survival_1'), (2, 'DeepDesert_1');
insert into dune.markers values
  (1, 'Cave_Small', 1, row(20000, 20000, 3000)::dune.vec3),
  (2, 'AzuriteOre', 1, row(-20000, 15000, 2500)::dune.vec3),
  (3, 'TradingPost_Atreides', 1, row(5000, -5000, 3500)::dune.vec3),
  (4, 'Hazard_Quicksand', 1, row(-30000, -30000, 2000)::dune.vec3),
  (5, 'EnemyCamp', 1, row(15000, 30000, 2800)::dune.vec3),
  (6, 'NoIcon', 1, row(0, 0, 0)::dune.vec3),
  (7, 'Cave_Deep', 2, row(-400000, 500000, 900)::dune.vec3);
`;

export async function createFixtureDb() {
  const db = await PGlite.create();
  await db.exec(SCHEMA);
  await db.exec(DATA);
  return db;
}
