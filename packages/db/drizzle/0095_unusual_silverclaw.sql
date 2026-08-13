CREATE TABLE `unmanaged_workspace_mutation_lease_events` (
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
CREATE INDEX `unmanaged_workspace_mutation_lease_events_workspace_idx` ON `unmanaged_workspace_mutation_lease_events` (`host_id`,`canonical_path`,`id`);--> statement-breakpoint
CREATE INDEX `unmanaged_workspace_mutation_lease_events_request_idx` ON `unmanaged_workspace_mutation_lease_events` (`request_id`);--> statement-breakpoint
CREATE TABLE `unmanaged_workspace_mutation_leases` (
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
CREATE UNIQUE INDEX `unmanaged_workspace_mutation_leases_request_idx` ON `unmanaged_workspace_mutation_leases` (`request_id`);--> statement-breakpoint
CREATE INDEX `unmanaged_workspace_mutation_leases_thread_idx` ON `unmanaged_workspace_mutation_leases` (`thread_id`);--> statement-breakpoint
CREATE TABLE `unmanaged_workspace_mutation_waiters` (
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
CREATE UNIQUE INDEX `unmanaged_workspace_mutation_waiters_request_idx` ON `unmanaged_workspace_mutation_waiters` (`request_id`);--> statement-breakpoint
CREATE INDEX `unmanaged_workspace_mutation_waiters_fifo_idx` ON `unmanaged_workspace_mutation_waiters` (`host_id`,`canonical_path`,`state`,`sequence`);--> statement-breakpoint
ALTER TABLE `projects` ADD `protect_unmanaged_workspace` integer DEFAULT false NOT NULL;