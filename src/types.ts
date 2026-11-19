// Subsets of Canvas API objects — only the fields this connector reads.

export interface Enrollment {
  type: string;
  enrollment_state?: string;
  computed_current_score?: number | null;
  computed_current_grade?: string | null;
  computed_final_score?: number | null;
  computed_final_grade?: string | null;
}

export interface Course {
  id: number;
  name: string;
  course_code: string;
  workflow_state?: string;
  start_at?: string | null;
  end_at?: string | null;
  restrict_enrollments_to_course_dates?: boolean;
  /** Present with include[]=concluded. */
  concluded?: boolean;
  term?: { name: string; start_at?: string | null; end_at?: string | null };
  enrollments?: Enrollment[];
  syllabus_body?: string | null;
  html_url?: string;
  apply_assignment_group_weights?: boolean;
  grading_standard_id?: number | null;
}

export interface SubmissionComment {
  author_name: string;
  comment: string;
  created_at: string;
  attachments?: Array<{ display_name?: string; filename?: string; url?: string }>;
}

export interface RubricRating {
  id: string;
  description: string;
  long_description?: string | null;
  points: number;
}

export interface RubricCriterion {
  id: string;
  description: string;
  long_description?: string | null;
  points: number;
  ratings?: RubricRating[];
}

/** Keyed by criterion id. */
export type RubricAssessment = Record<string, { points?: number | null; rating_id?: string | null; comments?: string | null }>;

export interface Submission {
  workflow_state: "unsubmitted" | "submitted" | "graded" | "pending_review" | string;
  submitted_at: string | null;
  submission_type?: string | null;
  score: number | null;
  grade: string | null;
  late?: boolean;
  missing?: boolean;
  excused?: boolean | null;
  attempt: number | null;
  submission_comments?: SubmissionComment[];
  preview_url?: string;
  assignment_id?: number;
  graded_at?: string | null;
  rubric_assessment?: RubricAssessment | null;
  /** Present with include[]=assignment. */
  assignment?: Assignment;
}

export interface Assignment {
  id: number;
  course_id: number;
  name: string;
  description: string | null;
  due_at: string | null;
  lock_at: string | null;
  unlock_at: string | null;
  points_possible: number | null;
  submission_types: string[];
  allowed_extensions?: string[];
  allowed_attempts?: number | null;
  html_url: string;
  locked_for_user?: boolean;
  lock_explanation?: string;
  published?: boolean;
  is_quiz_assignment?: boolean;
  omit_from_final_grade?: boolean;
  rubric?: RubricCriterion[];
  grading_type?: string;
  submission?: Submission;
}

export interface AssignmentGroup {
  id: number;
  name: string;
  group_weight: number | null;
  rules?: { drop_lowest?: number; drop_highest?: number; never_drop?: number[] } | null;
  assignments?: Assignment[];
}

export interface GradingStandard {
  id: number;
  title: string;
  /** Lowest score for each letter, as a fraction of 1 (0.94 = 94%). */
  grading_scheme: Array<{ name: string; value: number }>;
}

export interface PlannerItem {
  plannable_type: string;
  plannable_id: number;
  plannable_date: string;
  course_id?: number;
  context_name?: string;
  context_type?: string;
  html_url?: string;
  plannable: { title: string; due_at?: string | null; todo_date?: string | null; points_possible?: number | null; details?: string };
  submissions:
    | false
    | { submitted?: boolean; graded?: boolean; missing?: boolean; late?: boolean; excused?: boolean; has_feedback?: boolean; needs_grading?: boolean };
  planner_override?: { marked_complete?: boolean; dismissed?: boolean } | null;
  new_activity?: boolean;
}

export interface DiscussionTopic {
  id: number;
  title: string;
  message: string | null;
  posted_at: string | null;
  context_code?: string;
  html_url: string;
  author?: { display_name?: string };
  user_name?: string;
  assignment_id?: number | null;
  assignment?: Assignment | null;
  require_initial_post?: boolean | null;
  /** False when the topic requires an initial post and the student hasn't made one. */
  user_can_see_posts?: boolean;
  unread_count?: number;
  discussion_subentry_count?: number;
  last_reply_at?: string | null;
  locked_for_user?: boolean;
  read_state?: string;
}

export interface DiscussionEntry {
  id: number;
  user_id?: number;
  message?: string | null;
  created_at?: string;
  deleted?: boolean;
  replies?: DiscussionEntry[];
}

/** GET /courses/:id/discussion_topics/:tid/view */
export interface DiscussionView {
  participants?: Array<{ id: number; display_name: string }>;
  view?: DiscussionEntry[];
}

export interface CanvasFile {
  id: number;
  display_name: string;
  filename?: string;
  updated_at?: string | null;
  size?: number;
  "content-type"?: string;
  /** Download link on the Canvas host; empty when the file is locked for the student. */
  url?: string;
  locked_for_user?: boolean;
  lock_explanation?: string;
}

export interface Page {
  url: string; // the page's slug, not a link
  title: string;
  html_url?: string;
  body?: string | null;
  updated_at?: string | null;
}

export interface ModuleItem {
  id: number;
  title: string;
  type: "File" | "Page" | "Discussion" | "Assignment" | "Quiz" | "SubHeader" | "ExternalUrl" | "ExternalTool" | string;
  content_id?: number;
  page_url?: string;
  html_url?: string;
  external_url?: string;
  position?: number;
  indent?: number;
  completion_requirement?: {
    type: "must_view" | "must_submit" | "must_contribute" | "min_score" | "must_mark_done" | string;
    min_score?: number;
    completed?: boolean;
  } | null;
  /** Present with include[]=content_details. */
  content_details?: {
    points_possible?: number | null;
    due_at?: string | null;
    unlock_at?: string | null;
    lock_at?: string | null;
    locked_for_user?: boolean;
  };
}

export interface Module {
  id: number;
  name: string;
  /** Left out by Canvas when the module has too many items (about 50+); fetch items_url instead. */
  items?: ModuleItem[];
  position?: number;
  unlock_at?: string | null;
  require_sequential_progress?: boolean;
  prerequisite_module_ids?: number[];
  /** The student's progress: locked, unlocked, started or completed. */
  state?: "locked" | "unlocked" | "started" | "completed" | string;
  completed_at?: string | null;
  items_count?: number;
}

export interface CourseUser {
  id: number;
  name: string;
  /** Only when the student is allowed to see it (include[]=email). */
  email?: string | null;
  pronouns?: string | null;
  /** Present with include[]=enrollments. */
  enrollments?: Array<{ type: string; role?: string; course_id?: number }>;
}

export interface Group {
  id: number;
  name: string;
  course_id?: number;
  context_type?: string;
  members_count?: number;
}

export interface CalendarEvent {
  id: number | string;
  title: string;
  start_at: string | null;
  end_at: string | null;
  all_day?: boolean;
  /** YYYY-MM-DD, for all-day events. */
  all_day_date?: string | null;
  location_name?: string | null;
  location_address?: string | null;
  description?: string | null;
  context_code?: string;
  workflow_state?: string;
  html_url?: string;
}

export interface ConversationAttachment {
  display_name?: string;
  filename?: string;
  url?: string;
}

export interface ConversationMessage {
  id: number;
  author_id: number;
  created_at: string;
  body: string;
  attachments?: ConversationAttachment[];
  media_comment?: { display_name?: string; url?: string } | null;
}

export interface Conversation {
  id: number;
  subject: string | null;
  workflow_state: "read" | "unread" | "archived" | string;
  last_message?: string | null;
  last_message_at?: string | null;
  last_authored_message_at?: string | null;
  message_count?: number;
  participants?: Array<{ id: number; name: string }>;
  context_name?: string | null;
  context_code?: string | null;
  properties?: string[];
  /** Present on GET /conversations/:id, newest first. */
  messages?: ConversationMessage[];
}
