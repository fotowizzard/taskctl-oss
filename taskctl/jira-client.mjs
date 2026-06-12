/**
 * JiraClient for taskctl — READ ONLY
 * Adapted from a standard Jira REST client, extended with fetch methods.
 * Current phase: read-only access (no status updates, no comments).
 */

const RETRY_MAX_ATTEMPTS = 4;
const RETRY_BASE_DELAY_MS = 1000;
const RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 504]);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterHeader(value) {
  if (!value) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

export class JiraClient {
  constructor(config) {
    this.baseUrl = config.baseUrl;
    this.authHeader = `Basic ${Buffer.from(`${config.email}:${config.token}`).toString('base64')}`;
    this.projectKey = config.projectKey;
  }

  // --- Read methods (safe, no side effects) ---

  /** Fetch full issue data by key (e.g. "CP-133") */
  async fetchIssue(issueKey) {
    const fields = [
      'summary', 'description', 'status', 'priority', 'assignee',
      'labels', 'issuelinks', 'comment', 'parent', 'issuetype',
      'attachment',
      'customfield_10020', // sprint (Jira Cloud)
    ].join(',');

    return this.requestJson('GET', `/rest/api/3/issue/${enc(issueKey)}?fields=${fields}&expand=names`);
  }

  /** Fetch comments for an issue */
  async fetchComments(issueKey, maxResults = 100) {
    const response = await this.requestJson(
      'GET',
      `/rest/api/3/issue/${enc(issueKey)}/comment?maxResults=${maxResults}&orderBy=-created`
    );
    return response?.comments ?? [];
  }

  /** Fetch linked issues */
  async fetchLinks(issueKey) {
    const issue = await this.requestJson(
      'GET',
      `/rest/api/3/issue/${enc(issueKey)}?fields=issuelinks`
    );
    return issue?.fields?.issuelinks ?? [];
  }

  /** Search issues by JQL */
  async search(jql, fields = ['summary', 'status', 'priority', 'assignee'], maxResults = 50) {
    const query = new URLSearchParams({
      jql,
      fields: fields.join(','),
      maxResults: String(maxResults),
    });
    const response = await this.requestJson('GET', `/rest/api/3/search/jql?${query}`);
    return response?.issues ?? [];
  }

  /** Fetch all issues in current sprint for the project */
  async fetchSprintIssues(sprintName) {
    const jql = sprintName
      ? `project = "${this.projectKey}" AND sprint = "${sprintName}" ORDER BY priority DESC`
      : `project = "${this.projectKey}" AND sprint in openSprints() ORDER BY priority DESC`;
    return this.search(jql, ['summary', 'status', 'priority', 'assignee', 'labels', 'parent']);
  }

  /** Check issue exists and get basic info */
  async getIssueByKey(issueKey, fields = []) {
    const query = fields.length > 0 ? `?fields=${encodeURIComponent(fields.join(','))}` : '';
    return this.requestJson('GET', `/rest/api/3/issue/${enc(issueKey)}${query}`, undefined, 200, { allowNotFound: true });
  }

  /** Fetch summary + description for linked issues */
  async fetchLinkedIssueDetails(links) {
    const keys = new Set();
    for (const link of links) {
      if (link.outwardIssue) keys.add(link.outwardIssue.key);
      if (link.inwardIssue) keys.add(link.inwardIssue.key);
    }
    const details = {};
    for (const key of keys) {
      try {
        const issue = await this.requestJson(
          'GET',
          `/rest/api/3/issue/${enc(key)}?fields=summary,description,status,issuetype`
        );
        details[key] = issue;
      } catch { /* skip if inaccessible */ }
    }
    return details;
  }

  /** Download an attachment by URL, returns Buffer */
  async downloadAttachment(url) {
    const response = await fetch(url, {
      headers: { Authorization: this.authHeader },
    });
    if (!response.ok) throw new Error(`Download failed: ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }

  // --- Write methods (selective — enabled per flag) ---

  /** Assign issue to a user by accountId or email */
  async assignIssue(issueKey, accountId) {
    await this.requestJson('PUT', `/rest/api/3/issue/${enc(issueKey)}/assignee`, { accountId }, 204);
  }

  /** Find user accountId by email */
  async findUser(email) {
    const users = await this.requestJson('GET', `/rest/api/3/user/search?query=${encodeURIComponent(email)}`, undefined, 200);
    return users?.[0] ?? null;
  }

  /** Add labels to an issue (without removing existing ones) */
  async addLabels(issueKey, labels) {
    const update = { labels: labels.map(l => ({ add: l })) };
    await this.requestJson('PUT', `/rest/api/3/issue/${enc(issueKey)}`, { update }, 204);
  }

  // async addComment(issueKey, adfBody) { ... }
  // async transitionIssue(issueKey, transitionId) { ... }
  // These will be enabled after orchestration system is validated.

  // --- HTTP layer (standard Jira REST request/retry) ---

  async requestJson(method, requestPath, body, expectedStatus = 200, { allowNotFound = false } = {}) {
    const response = await this.fetchWithRetry(method, requestPath, body);

    if (allowNotFound && response.status === 404) {
      return null;
    }

    if (response.status !== expectedStatus) {
      const errorText = await response.text();
      throw new Error(`Jira API ${method} ${requestPath} failed with ${response.status}: ${errorText}`);
    }

    // 204 No Content — nothing to parse
    if (response.status === 204) return null;

    return response.json();
  }

  async fetchWithRetry(method, requestPath, body) {
    const url = `${this.baseUrl}${requestPath}`;
    const headers = {
      Authorization: this.authHeader,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    };
    const requestBody = body ? JSON.stringify(body) : undefined;

    for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt += 1) {
      const response = await fetch(url, { method, headers, body: requestBody });

      if (!RETRYABLE_STATUS_CODES.has(response.status)) {
        return response;
      }

      if (attempt === RETRY_MAX_ATTEMPTS) {
        return response;
      }

      const retryAfter = parseRetryAfterHeader(response.headers.get('retry-after'));
      const backoffMs = retryAfter ?? RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);

      console.warn(`  retry ${attempt}/${RETRY_MAX_ATTEMPTS} after ${response.status}, wait ${backoffMs}ms`);
      await delay(backoffMs);
    }
  }
}

function enc(value) {
  return encodeURIComponent(value);
}
