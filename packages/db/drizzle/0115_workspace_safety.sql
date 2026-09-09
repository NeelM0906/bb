CREATE TABLE IF NOT EXISTS `environment_path_canonicalizations` (
	`environment_id` text PRIMARY KEY NOT NULL,
	`canonical_path` text NOT NULL,
	`path` text NOT NULL,
	`confirmed_at` integer NOT NULL,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `unmanaged_workspace_mutation_lease_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`host_id` text NOT NULL,
	`canonical_path` text NOT NULL,
	`thread_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`request_id` text NOT NULL,
	`generation` integer,
	`type` text NOT NULL,
	`reason` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `unmanaged_workspace_mutation_lease_events_workspace_idx` ON `unmanaged_workspace_mutation_lease_events` (`host_id`,`canonical_path`,`id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `unmanaged_workspace_mutation_lease_events_request_idx` ON `unmanaged_workspace_mutation_lease_events` (`request_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `unmanaged_workspace_mutation_leases` (
	`host_id` text NOT NULL,
	`canonical_path` text NOT NULL,
	`thread_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`request_id` text NOT NULL,
	`generation` integer NOT NULL,
	`acquired_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`host_id`, `canonical_path`),
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "unmanaged_workspace_mutation_leases_generation_check" CHECK("unmanaged_workspace_mutation_leases"."generation" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `unmanaged_workspace_mutation_leases_request_idx` ON `unmanaged_workspace_mutation_leases` (`request_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `unmanaged_workspace_mutation_leases_thread_idx` ON `unmanaged_workspace_mutation_leases` (`thread_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `unmanaged_workspace_mutation_waiters` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`request_id` text NOT NULL,
	`host_id` text NOT NULL,
	`canonical_path` text NOT NULL,
	`thread_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`state` text NOT NULL,
	`reason` text,
	`promoted_generation` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `unmanaged_workspace_mutation_waiters_request_idx` ON `unmanaged_workspace_mutation_waiters` (`request_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `unmanaged_workspace_mutation_waiters_fifo_idx` ON `unmanaged_workspace_mutation_waiters` (`host_id`,`canonical_path`,`state`,`sequence`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `work_admissions` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`host_id` text NOT NULL,
	`reason` text NOT NULL,
	`command_json` text NOT NULL,
	`status` text NOT NULL,
	`waiting_reason` text,
	`reservation_token` text,
	`reservation_generation` integer,
	`terminal_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "work_admissions_reservation_shape_check" CHECK((
        ("work_admissions"."status" = 'running' AND "work_admissions"."reservation_token" IS NOT NULL AND "work_admissions"."reservation_generation" IS NOT NULL)
        OR ("work_admissions"."status" != 'running')
      ))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `work_admissions_host_status_fifo_idx` ON `work_admissions` (`host_id`,`status`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `work_admissions_thread_status_idx` ON `work_admissions` (`thread_id`,`status`,`created_at`);--> statement-breakpoint
ALTER TABLE `projects` ADD `protect_unmanaged_workspace` integer DEFAULT false NOT NULL;