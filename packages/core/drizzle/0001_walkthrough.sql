ALTER TABLE "hotspots" ALTER COLUMN "type" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "scenes" ADD COLUMN "map_x" real;--> statement-breakpoint
ALTER TABLE "scenes" ADD COLUMN "map_y" real;--> statement-breakpoint
ALTER TABLE "tours" ADD COLUMN "floor_plan_key" text;--> statement-breakpoint
ALTER TABLE "tours" ADD COLUMN "floor_plan_width" integer;--> statement-breakpoint
ALTER TABLE "tours" ADD COLUMN "floor_plan_height" integer;--> statement-breakpoint
CREATE INDEX "hotspots_target_idx" ON "hotspots" USING btree ("target_scene_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hotspots_chain_key" ON "hotspots" USING btree ("scene_id","type","target_scene_id") WHERE "hotspots"."type" in ('next', 'back');--> statement-breakpoint
ALTER TABLE "hotspots" ADD CONSTRAINT "hotspots_kind_check" CHECK ("hotspots"."type" in ('next', 'back', 'link', 'info'));--> statement-breakpoint
DROP TYPE "public"."hotspot_type";