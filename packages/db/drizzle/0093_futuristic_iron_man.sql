CREATE TABLE `work_admissions` (
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
CREATE INDEX `work_admissions_host_status_fifo_idx` ON `work_admissions` (`host_id`,`status`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `work_admissions_thread_status_idx` ON `work_admissions` (`thread_id`,`status`,`created_at`);
