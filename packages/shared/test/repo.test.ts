import assert from "node:assert/strict";
import { test } from "node:test";
import { repoIdentity, sameRepo } from "../src/repo.ts";

test("GitHub ignores case, so its repo identity is lower case in every form", () => {
  for (const remote of ["git@github.com:GolferGeek/Opportunity-Nav.git", "https://github.com/GolferGeek/Opportunity-Nav",
    "ssh://git@GitHub.com/GolferGeek/opportunity-nav.git/", "https://user@github.com/golfergeek/opportunity-nav.git"]) {
    assert.equal(repoIdentity(remote), "github.com/golfergeek/opportunity-nav", remote);
  }
  assert.equal(repoIdentity("github.com/GolferGeek/Opportunity-Nav", { serverForm: true }), "github.com/golfergeek/opportunity-nav");
});

test("Other hosts keep the path's case: a case-only difference is another repo", () => {
  assert.equal(repoIdentity("https://Git.Example.com/Team/Repo.git"), "git.example.com/Team/Repo");
  assert.equal(repoIdentity("git@gitlab.com:Team/Repo.git"), "gitlab.com/Team/Repo");
  assert.equal(sameRepo("https://git.example.com/team/repo", "git@git.example.com:Team/Repo"), false);
  assert.equal(sameRepo("https://git.example.com/Team/Repo", "git@GIT.example.com:Team/Repo.git"), true);
  assert.equal(sameRepo("/srv/git/Repo.git", "/srv/git/repo.git"), false);
  assert.equal(repoIdentity("/srv/git/Repo.git/"), "/srv/git/Repo");
});

test("URL paths with encoded separators cannot match a repo with literal separators", () => {
  for (const separator of ["%2F", "%2f", "%5C", "%5c"]) {
    const remote = `https://git.example.com/Team${separator}Repo`;
    assert.equal(repoIdentity(remote), undefined);
    assert.equal(sameRepo(remote, "https://git.example.com/Team/Repo"), false);
  }
  assert.equal(repoIdentity("https://git.example.com/Team/R%C3%A9po"), "git.example.com/Team/Répo");
});

test("The server's bare form counts only when asked for, and non-addresses give nothing", () => {
  assert.equal(repoIdentity("github.com/a/b"), undefined);
  assert.equal(repoIdentity("git.example.com:8443/Team/Repo", { serverForm: true }), "git.example.com:8443/Team/Repo");
  assert.equal(repoIdentity("relative/path"), undefined);
  assert.equal(repoIdentity("file:///srv/git/repo"), undefined);
  assert.equal(repoIdentity("https://github.com/a/b?x=1"), undefined);
  assert.equal(repoIdentity(""), undefined);
});
