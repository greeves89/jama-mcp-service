/**
 * Typen der Jama-REST-API, so weit wir sie benoetigen.
 *
 * Bewusst tolerant gehalten: Jama liefert je nach Version und Konfiguration
 * zusaetzliche Felder, und Custom Fields tauchen mit dynamischen Namen auf
 * (z. B. "priority$32"). Ein zu enges Schema wuerde bei jedem Kundensystem
 * anders brechen.
 */

export interface JamaProject {
  id: number;
  projectKey?: string;
  isFolder?: boolean;
  createdDate?: string;
  modifiedDate?: string;
  fields?: {
    name?: string;
    description?: string;
    projectKey?: string;
    [key: string]: unknown;
  };
  parent?: number;
}

export interface JamaFieldDefinition {
  id?: number;
  name: string;
  label?: string;
  fieldType?: string;
  required?: boolean;
  readOnly?: boolean;
  pickList?: number;
  itemType?: number;
  /** Bei Feldern mit Verweis auf einen anderen ItemType. */
  relatedItemType?: number;
  synchronize?: boolean;
  triggerSuspect?: boolean;
}

export interface JamaItemType {
  id: number;
  typeKey?: string;
  display?: string;
  displayPlural?: string;
  description?: string;
  category?: string;
  image?: string;
  fields?: JamaFieldDefinition[];
}

export interface JamaPickListOption {
  id: number;
  name?: string;
  description?: string;
  value?: string;
  pickList?: number;
  active?: boolean;
  default?: boolean;
}

export interface JamaPickList {
  id: number;
  name?: string;
  description?: string;
}

export interface JamaItemLocation {
  sequence?: string;
  globalSortOrder?: number;
  sortOrder?: Record<string, unknown>;
  parent?: { item?: number; project?: number };
}

export interface JamaItem {
  id: number;
  documentKey?: string;
  globalId?: string;
  itemType?: number;
  childItemType?: number;
  project?: number;
  createdDate?: string;
  modifiedDate?: string;
  lastActivityDate?: string;
  createdBy?: number;
  modifiedBy?: number;
  location?: JamaItemLocation;
  lock?: { locked?: boolean; lastLockedDate?: string; lockedBy?: number };
  fields?: Record<string, unknown>;
  resources?: Record<string, unknown>;
  /** Bei abstractitems: 'items' | 'testplans' | 'testcycles' | 'testruns' | 'attachments' */
  type?: string;
}

export interface JamaRelationship {
  id: number;
  fromItem: number;
  toItem: number;
  relationshipType?: number;
  suspect?: boolean;
}

export interface JamaRelationshipType {
  id: number;
  name?: string;
  label?: string;
  fromLabel?: string;
  toLabel?: string;
  default?: boolean;
}

export interface JamaUser {
  id: number;
  username?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  active?: boolean;
  licenseType?: string;
  title?: string;
  location?: string;
  phone?: string;
}

export interface JamaUserGroup {
  id: number;
  name?: string;
  description?: string;
  organization?: number;
}

export interface JamaTag {
  id: number;
  name?: string;
  project?: number;
}

export interface JamaRelease {
  id: number;
  name?: string;
  description?: string;
  releaseDate?: string;
  active?: boolean;
  project?: number;
}

export interface JamaComment {
  id: number;
  body?: { text?: string };
  createdDate?: string;
  modifiedDate?: string;
  createdBy?: number;
  inReplyTo?: number;
  location?: { item?: number };
  status?: string;
  commentType?: string;
}

export interface JamaAttachment {
  id: number;
  fileName?: string;
  fields?: { name?: string; description?: string; [key: string]: unknown };
  createdDate?: string;
  createdBy?: number;
  project?: number;
  itemType?: number;
}

export interface JamaBaseline {
  id: number;
  project?: number;
  name?: string;
  description?: string;
  createdDate?: string;
  createdBy?: number;
  eventType?: string;
}

export interface JamaActivity {
  id: number;
  action?: string;
  date?: string;
  eventType?: string;
  objectType?: string;
  user?: number;
  associatedItems?: Array<{ id?: number; documentKey?: string; name?: string }>;
  project?: number;
}

export interface JamaTestPlan {
  id: number;
  project?: number;
  fields?: Record<string, unknown>;
  createdDate?: string;
}

export interface JamaTestCycle {
  id: number;
  project?: number;
  testPlan?: number;
  fields?: Record<string, unknown>;
  createdDate?: string;
}

export interface JamaTestRun {
  id: number;
  project?: number;
  testCycle?: number;
  testPlan?: number;
  documentKey?: string;
  fields?: {
    name?: string;
    testRunStatus?: string;
    executionDate?: string;
    assignedTo?: number;
    testCase?: number;
    testRunSteps?: Array<{
      action?: string;
      expectedResult?: string;
      notes?: string;
      status?: string;
    }>;
    [key: string]: unknown;
  };
}

export interface JamaFilter {
  id: number;
  name?: string;
  description?: string;
  project?: number;
  author?: number;
  filterScope?: string;
}

export interface JamaVersion {
  versionNumber: number;
  createdDate?: string;
  createdBy?: number;
  eventType?: string;
  relatedItem?: number;
}

export interface JamaReview {
  id: number;
  project?: number;
  name?: string;
  description?: string;
  status?: string;
  createdDate?: string;
  organizer?: number;
}

/** Ergebnis der Feature-Erkennung ueber GET /rest. */
export interface JamaCapabilities {
  versions: string[];
  hasLabs: boolean;
  detectedAt: string;
}
