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
}

export interface SubmissionComment {
  author_name: string;
  comment: string;
  created_at: string;
}

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
  submission?: Submission;
}

export interface AssignmentGroup {
  id: number;
  name: string;
  group_weight: number | null;
  assignments?: Assignment[];
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
}
