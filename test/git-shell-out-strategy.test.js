import fs from 'fs-extra';
import path from 'path';

import mkdirp from 'mkdirp';
import dedent from 'dedent-js';

import GitShellOutStrategy, {GitError} from '../lib/git-shell-out-strategy';

import {cloneRepository, assertDeepPropertyVals, setUpLocalAndRemoteRepositories} from './helpers';

/**
 * KU Thoughts: The GitShellOutStrategy methods are tested in Repository tests for the most part
 *  For now, in order to minimize duplication, I'll limit test coverage here to methods that produce
 *  output that we rely on, to serve as documentation
 */

describe('Git commands', function() {
  describe('isGitRepository(directoryPath)', function() {
    it('returns true if the path passed is a valid repository, and false if not', async function() {
      const workingDirPath = await cloneRepository('three-files');
      const git = new GitShellOutStrategy(workingDirPath);
      assert.isTrue(await git.isGitRepository(workingDirPath));

      fs.removeSync(path.join(workingDirPath, '.git'));
      assert.isFalse(await git.isGitRepository(workingDirPath));
    });
  });

  describe('getStatusesForChangedFiles', function() {
    it('returns objects for staged and unstaged files, including status information', async function() {
      const workingDirPath = await cloneRepository('three-files');
      const git = new GitShellOutStrategy(workingDirPath);
      fs.writeFileSync(path.join(workingDirPath, 'a.txt'), 'qux\nfoo\nbar\n', 'utf8');
      fs.unlinkSync(path.join(workingDirPath, 'b.txt'));
      fs.renameSync(path.join(workingDirPath, 'c.txt'), path.join(workingDirPath, 'd.txt'));
      fs.writeFileSync(path.join(workingDirPath, 'e.txt'), 'qux', 'utf8');
      await git.exec(['add', 'a.txt', 'e.txt']);
      fs.writeFileSync(path.join(workingDirPath, 'a.txt'), 'modify after staging', 'utf8');
      fs.writeFileSync(path.join(workingDirPath, 'e.txt'), 'modify after staging', 'utf8');
      const {stagedFiles, unstagedFiles, mergeConflictFiles} = await git.getStatusesForChangedFiles();
      assert.deepEqual(stagedFiles, {
        'a.txt': 'modified',
        'e.txt': 'added',
      });
      assert.deepEqual(unstagedFiles, {
        'a.txt': 'modified',
        'b.txt': 'deleted',
        'c.txt': 'deleted',
        'd.txt': 'added',
        'e.txt': 'modified',
      });
      assert.deepEqual(mergeConflictFiles, {});
    });

    it('displays renamed files as one removed file and one added file', async function() {
      const workingDirPath = await cloneRepository('three-files');
      const git = new GitShellOutStrategy(workingDirPath);
      fs.renameSync(path.join(workingDirPath, 'c.txt'), path.join(workingDirPath, 'd.txt'));
      await git.exec(['add', '.']);
      const {stagedFiles, unstagedFiles, mergeConflictFiles} = await git.getStatusesForChangedFiles();
      assert.deepEqual(stagedFiles, {
        'c.txt': 'deleted',
        'd.txt': 'added',
      });
      assert.deepEqual(unstagedFiles, {});
      assert.deepEqual(mergeConflictFiles, {});
    });

    it('displays copied files as an added file', async function() {
      // This repo is carefully constructed after much experimentation
      // to cause git to detect `two.cc` as a copy of `one.cc`.
      const workingDirPath = await cloneRepository('copied-file');
      const git = new GitShellOutStrategy(workingDirPath);
      // Undo the last commit, which is where we copied one.cc to two.cc
      // and then emptied one.cc.
      await git.exec(['reset', '--soft', 'head^']);
      const {stagedFiles, unstagedFiles, mergeConflictFiles} = await git.getStatusesForChangedFiles();
      assert.deepEqual(stagedFiles, {
        'one.cc': 'modified',
        'two.cc': 'added',
      });
      assert.deepEqual(unstagedFiles, {});
      assert.deepEqual(mergeConflictFiles, {});
    });

    it('returns an object for merge conflict files, including ours/theirs/file status information', async function() {
      const workingDirPath = await cloneRepository('merge-conflict');
      const git = new GitShellOutStrategy(workingDirPath);
      try {
        await git.merge('origin/branch');
      } catch (e) {
        // expected
        if (!e.message.match(/CONFLICT/)) {
          throw new Error(`merge failed for wrong reason: ${e.message}`);
        }
      }

      const {stagedFiles, unstagedFiles, mergeConflictFiles} = await git.getStatusesForChangedFiles();
      assert.deepEqual(stagedFiles, {});
      assert.deepEqual(unstagedFiles, {});

      assert.deepEqual(mergeConflictFiles, {
        'added-to-both.txt': {
          ours: 'added',
          theirs: 'added',
          file: 'modified',
        },
        'modified-on-both-ours.txt': {
          ours: 'modified',
          theirs: 'modified',
          file: 'modified',
        },
        'modified-on-both-theirs.txt': {
          ours: 'modified',
          theirs: 'modified',
          file: 'modified',
        },
        'removed-on-branch.txt': {
          ours: 'modified',
          theirs: 'deleted',
          file: 'equivalent',
        },
        'removed-on-master.txt': {
          ours: 'deleted',
          theirs: 'modified',
          file: 'added',
        },
      });
    });
  });

  describe('diffFileStatus', function() {
    it('returns an object with working directory file diff status between relative to specified target commit', async function() {
      const workingDirPath = await cloneRepository('three-files');
      const git = new GitShellOutStrategy(workingDirPath);
      fs.writeFileSync(path.join(workingDirPath, 'a.txt'), 'qux\nfoo\nbar\n', 'utf8');
      fs.unlinkSync(path.join(workingDirPath, 'b.txt'));
      fs.renameSync(path.join(workingDirPath, 'c.txt'), path.join(workingDirPath, 'd.txt'));
      fs.writeFileSync(path.join(workingDirPath, 'e.txt'), 'qux', 'utf8');
      const diffOutput = await git.diffFileStatus({target: 'HEAD'});
      assert.deepEqual(diffOutput, {
        'a.txt': 'modified',
        'b.txt': 'deleted',
        'c.txt': 'deleted',
        'd.txt': 'added',
        'e.txt': 'added',
      });
    });

    it('returns an empty object if there are no added, modified, or removed files', async function() {
      const workingDirPath = await cloneRepository('three-files');
      const git = new GitShellOutStrategy(workingDirPath);
      const diffOutput = await git.diffFileStatus({target: 'HEAD'});
      assert.deepEqual(diffOutput, {});
    });

    it('only returns untracked files if the staged option is not passed', async function() {
      const workingDirPath = await cloneRepository('three-files');
      const git = new GitShellOutStrategy(workingDirPath);
      fs.writeFileSync(path.join(workingDirPath, 'new-file.txt'), 'qux', 'utf8');
      let diffOutput = await git.diffFileStatus({target: 'HEAD'});
      assert.deepEqual(diffOutput, {'new-file.txt': 'added'});
      diffOutput = await git.diffFileStatus({target: 'HEAD', staged: true});
      assert.deepEqual(diffOutput, {});
    });
  });

  describe('getUntrackedFiles', function() {
    it('returns an array of untracked file paths', async function() {
      const workingDirPath = await cloneRepository('three-files');
      const git = new GitShellOutStrategy(workingDirPath);
      fs.writeFileSync(path.join(workingDirPath, 'd.txt'), 'foo', 'utf8');
      fs.writeFileSync(path.join(workingDirPath, 'e.txt'), 'bar', 'utf8');
      fs.writeFileSync(path.join(workingDirPath, 'f.txt'), 'qux', 'utf8');
      assert.deepEqual(await git.getUntrackedFiles(), ['d.txt', 'e.txt', 'f.txt']);
    });

    it('handles untracked files in nested folders', async function() {
      const workingDirPath = await cloneRepository('three-files');
      const git = new GitShellOutStrategy(workingDirPath);
      fs.writeFileSync(path.join(workingDirPath, 'd.txt'), 'foo', 'utf8');
      const folderPath = path.join(workingDirPath, 'folder', 'subfolder');
      mkdirp.sync(folderPath);
      fs.writeFileSync(path.join(folderPath, 'e.txt'), 'bar', 'utf8');
      fs.writeFileSync(path.join(folderPath, 'f.txt'), 'qux', 'utf8');
      assert.deepEqual(await git.getUntrackedFiles(), [
        'd.txt',
        'folder/subfolder/e.txt',
        'folder/subfolder/f.txt',
      ]);
    });

    it('returns an empty array if there are no untracked files', async function() {
      const workingDirPath = await cloneRepository('three-files');
      const git = new GitShellOutStrategy(workingDirPath);
      assert.deepEqual(await git.getUntrackedFiles(), []);
    });
  });

  describe('getDiffForFilePath', function() {
    it('returns an empty array if there are no modified, added, or deleted files', async function() {
      const workingDirPath = await cloneRepository('three-files');
      const git = new GitShellOutStrategy(workingDirPath);

      const diffOutput = await git.getDiffForFilePath('a.txt');
      assert.isUndefined(diffOutput);
    });

    it('ignores merge conflict files', async function() {
      const workingDirPath = await cloneRepository('merge-conflict');
      const git = new GitShellOutStrategy(workingDirPath);
      const diffOutput = await git.getDiffForFilePath('added-to-both.txt');
      assert.isUndefined(diffOutput);
    });

    describe('when the file is unstaged', function() {
      it('returns a diff comparing the working directory copy of the file and the version on the index', async function() {
        const workingDirPath = await cloneRepository('three-files');
        const git = new GitShellOutStrategy(workingDirPath);
        fs.writeFileSync(path.join(workingDirPath, 'a.txt'), 'qux\nfoo\nbar\n', 'utf8');
        fs.renameSync(path.join(workingDirPath, 'c.txt'), path.join(workingDirPath, 'd.txt'));

        assertDeepPropertyVals(await git.getDiffForFilePath('a.txt'), {
          oldPath: 'a.txt',
          newPath: 'a.txt',
          oldMode: '100644',
          newMode: '100644',
          hunks: [
            {
              oldStartLine: 1,
              oldLineCount: 1,
              newStartLine: 1,
              newLineCount: 3,
              heading: '',
              lines: [
                '+qux',
                ' foo',
                '+bar',
              ],
            },
          ],
          status: 'modified',
        });

        assertDeepPropertyVals(await git.getDiffForFilePath('c.txt'), {
          oldPath: 'c.txt',
          newPath: null,
          oldMode: '100644',
          newMode: null,
          hunks: [
            {
              oldStartLine: 1,
              oldLineCount: 1,
              newStartLine: 0,
              newLineCount: 0,
              heading: '',
              lines: ['-baz'],
            },
          ],
          status: 'deleted',
        });

        assertDeepPropertyVals(await git.getDiffForFilePath('d.txt'), {
          oldPath: null,
          newPath: 'd.txt',
          oldMode: null,
          newMode: '100644',
          hunks: [
            {
              oldStartLine: 0,
              oldLineCount: 0,
              newStartLine: 1,
              newLineCount: 1,
              heading: '',
              lines: ['+baz'],
            },
          ],
          status: 'added',
        });
      });
    });

    describe('when the file is staged', function() {
      it('returns a diff comparing the index and head versions of the file', async function() {
        const workingDirPath = await cloneRepository('three-files');
        const git = new GitShellOutStrategy(workingDirPath);
        fs.writeFileSync(path.join(workingDirPath, 'a.txt'), 'qux\nfoo\nbar\n', 'utf8');
        fs.renameSync(path.join(workingDirPath, 'c.txt'), path.join(workingDirPath, 'd.txt'));
        await git.exec(['add', '.']);

        assertDeepPropertyVals(await git.getDiffForFilePath('a.txt', {staged: true}), {
          oldPath: 'a.txt',
          newPath: 'a.txt',
          oldMode: '100644',
          newMode: '100644',
          hunks: [
            {
              oldStartLine: 1,
              oldLineCount: 1,
              newStartLine: 1,
              newLineCount: 3,
              heading: '',
              lines: [
                '+qux',
                ' foo',
                '+bar',
              ],
            },
          ],
          status: 'modified',
        });

        assertDeepPropertyVals(await git.getDiffForFilePath('c.txt', {staged: true}), {
          oldPath: 'c.txt',
          newPath: null,
          oldMode: '100644',
          newMode: null,
          hunks: [
            {
              oldStartLine: 1,
              oldLineCount: 1,
              newStartLine: 0,
              newLineCount: 0,
              heading: '',
              lines: ['-baz'],
            },
          ],
          status: 'deleted',
        });

        assertDeepPropertyVals(await git.getDiffForFilePath('d.txt', {staged: true}), {
          oldPath: null,
          newPath: 'd.txt',
          oldMode: null,
          newMode: '100644',
          hunks: [
            {
              oldStartLine: 0,
              oldLineCount: 0,
              newStartLine: 1,
              newLineCount: 1,
              heading: '',
              lines: ['+baz'],
            },
          ],
          status: 'added',
        });
      });
    });

    describe('when the file is staged and a base commit is specified', function() {
      it('returns a diff comparing the file on the index and in the specified commit', async function() {
        const workingDirPath = await cloneRepository('multiple-commits');
        const git = new GitShellOutStrategy(workingDirPath);

        assertDeepPropertyVals(await git.getDiffForFilePath('file.txt', {staged: true, baseCommit: 'HEAD~'}), {
          oldPath: 'file.txt',
          newPath: 'file.txt',
          oldMode: '100644',
          newMode: '100644',
          hunks: [
            {
              oldStartLine: 1,
              oldLineCount: 1,
              newStartLine: 1,
              newLineCount: 1,
              heading: '',
              lines: ['-two', '+three'],
            },
          ],
          status: 'modified',
        });
      });
    });
  });

  describe('isPartiallyStaged(filePath)', () => {
    it('returns true if specified file path is partially staged', async () => {
      const workingDirPath = await cloneRepository('three-files');
      const git = new GitShellOutStrategy(workingDirPath);
      fs.writeFileSync(path.join(workingDirPath, 'a.txt'), 'modified file', 'utf8');
      fs.writeFileSync(path.join(workingDirPath, 'new-file.txt'), 'foo\nbar\nbaz\n', 'utf8');
      fs.writeFileSync(path.join(workingDirPath, 'b.txt'), 'blah blah blah', 'utf8');
      fs.unlinkSync(path.join(workingDirPath, 'c.txt'));

      assert.isFalse(await git.isPartiallyStaged('a.txt'));
      assert.isFalse(await git.isPartiallyStaged('b.txt'));
      assert.isFalse(await git.isPartiallyStaged('c.txt'));
      assert.isFalse(await git.isPartiallyStaged('new-file.txt'));

      await git.stageFiles(['a.txt', 'b.txt', 'c.txt', 'new-file.txt']);
      assert.isFalse(await git.isPartiallyStaged('a.txt'));
      assert.isFalse(await git.isPartiallyStaged('b.txt'));
      assert.isFalse(await git.isPartiallyStaged('c.txt'));
      assert.isFalse(await git.isPartiallyStaged('new-file.txt'));

      // modified on both
      fs.writeFileSync(path.join(workingDirPath, 'a.txt'), 'more mods', 'utf8');
      // modified in working directory, added on index
      fs.writeFileSync(path.join(workingDirPath, 'new-file.txt'), 'foo\nbar\nbaz\nqux\n', 'utf8');
      // deleted in working directory, modified on index
      fs.unlinkSync(path.join(workingDirPath, 'b.txt'));
      // untracked in working directory, deleted on index
      fs.writeFileSync(path.join(workingDirPath, 'c.txt'), 'back baby', 'utf8');

      assert.isTrue(await git.isPartiallyStaged('a.txt'));
      assert.isTrue(await git.isPartiallyStaged('b.txt'));
      assert.isTrue(await git.isPartiallyStaged('c.txt'));
      assert.isTrue(await git.isPartiallyStaged('new-file.txt'));
    });
  });

  describe('isMerging', function() {
    it('returns true if `.git/MERGE_HEAD` exists', async function() {
      const workingDirPath = await cloneRepository('merge-conflict');
      const git = new GitShellOutStrategy(workingDirPath);
      let isMerging = await git.isMerging();
      assert.isFalse(isMerging);

      try {
        await git.merge('origin/branch');
      } catch (e) {
        // expect merge to have conflicts
      }
      isMerging = await git.isMerging();
      assert.isTrue(isMerging);

      fs.unlinkSync(path.join(workingDirPath, '.git', 'MERGE_HEAD'));
      isMerging = await git.isMerging();
      assert.isFalse(isMerging);
    });
  });

  describe('getAheadCount(branchName) and getBehindCount(branchName)', function() {
    it('returns the number of different commits on the branch vs the remote', async function() {
      const {localRepoPath} = await setUpLocalAndRemoteRepositories({remoteAhead: true});
      const git = new GitShellOutStrategy(localRepoPath);
      await git.exec(['config', 'push.default', 'upstream']);
      assert.equal(await git.getBehindCount('master'), 0);
      assert.equal(await git.getAheadCount('master'), 0);
      await git.fetch('master');
      assert.equal(await git.getBehindCount('master'), 1);
      assert.equal(await git.getAheadCount('master'), 0);
      await git.commit('new commit', {allowEmpty: true});
      await git.commit('another commit', {allowEmpty: true});
      assert.equal(await git.getBehindCount('master'), 1);
      assert.equal(await git.getAheadCount('master'), 2);
    });

    it('returns null if there is no remote tracking branch specified', async function() {
      const {localRepoPath} = await setUpLocalAndRemoteRepositories({remoteAhead: true});
      const git = new GitShellOutStrategy(localRepoPath);
      await git.exec(['config', 'push.default', 'upstream']);
      await git.exec(['config', '--remove-section', 'branch.master']);
      assert.equal(await git.getBehindCount('master'), null);
      assert.equal(await git.getAheadCount('master'), null);
    });

    it('returns null if the configured remote tracking branch does not exist locally', async function() {
      const {localRepoPath} = await setUpLocalAndRemoteRepositories();
      const git = new GitShellOutStrategy(localRepoPath);
      await git.exec(['config', 'push.default', 'upstream']);
      await git.exec(['branch', '-d', '-r', 'origin/master']);
      assert.equal(await git.getBehindCount('master'), null);
      assert.equal(await git.getAheadCount('master'), null);

      await git.exec(['fetch']);
      assert.equal(await git.getBehindCount('master'), 0);
      assert.equal(await git.getAheadCount('master'), 0);
    });

    it('handles a remote tracking branch with a name that differs from the local branch', async function() {
      const {localRepoPath} = await setUpLocalAndRemoteRepositories({remoteAhead: true});
      const git = new GitShellOutStrategy(localRepoPath);
      await git.exec(['config', 'push.default', 'upstream']);
      await git.exec(['checkout', '-b', 'new-local-branch']);
      await git.exec(['remote', 'rename', 'origin', 'upstream']);
      await git.exec(['branch', '--set-upstream-to=upstream/master']);
      assert.equal(await git.getBehindCount('new-local-branch'), 0);
      assert.equal(await git.getAheadCount('new-local-branch'), 0);
    });
  });

  describe('getCurrentBranch() and checkout(branchName, {createNew})', function() {
    it('returns the current branch name', async function() {
      const workingDirPath = await cloneRepository('merge-conflict');
      const git = new GitShellOutStrategy(workingDirPath);
      assert.equal(await git.getCurrentBranch(), 'master');
      await git.checkout('branch');
      assert.equal(await git.getCurrentBranch(), 'branch');

      // newBranch does not yet exist
      await assert.isRejected(git.checkout('newBranch'));
      assert.equal(await git.getCurrentBranch(), 'branch');
      await git.checkout('newBranch', {createNew: true});
      assert.equal(await git.getCurrentBranch(), 'newBranch');
    });
  });

  describe('getRemoteForBranch(branchName)', function() {
    it('returns the name of the remote associated with the branch, and null if none exists', async function() {
      const workingDirPath = await cloneRepository('three-files');
      const git = new GitShellOutStrategy(workingDirPath);
      assert.equal(await git.getRemoteForBranch('master'), 'origin');
      await git.exec(['remote', 'rename', 'origin', 'foo']);
      assert.equal(await git.getRemoteForBranch('master'), 'foo');
      await git.exec(['remote', 'rm', 'foo']);
      assert.isNull(await git.getRemoteForBranch('master'));
    });
  });

  describe('getBranches()', function() {
    it('returns an array of all branches', async function() {
      const workingDirPath = await cloneRepository('three-files');
      const git = new GitShellOutStrategy(workingDirPath);
      assert.deepEqual(await git.getBranches(), ['master']);
      await git.checkout('new-branch', {createNew: true});
      assert.deepEqual(await git.getBranches(), ['master', 'new-branch']);
      await git.checkout('another-branch', {createNew: true});
      assert.deepEqual(await git.getBranches(), ['another-branch', 'master', 'new-branch']);
    });
  });

  describe('getRemotes()', function() {
    it('returns an array of remotes', async function() {
      const workingDirPath = await cloneRepository('three-files');
      const git = new GitShellOutStrategy(workingDirPath);
      await git.exec(['remote', 'set-url', 'origin', 'git@github.com:other/origin.git']);
      await git.exec(['remote', 'add', 'upstream', 'git@github.com:my/upstream.git']);
      await git.exec(['remote', 'add', 'another.remote', 'git@github.com:another/upstream.git']);
      const remotes = await git.getRemotes();
      assert.deepEqual(remotes, [
        {name: 'origin', url: 'git@github.com:other/origin.git'},
        {name: 'upstream', url: 'git@github.com:my/upstream.git'},
        {name: 'another.remote', url: 'git@github.com:another/upstream.git'},
      ]);
    });

    it('returns an empty array when no remotes are set up', async function() {
      const workingDirPath = await cloneRepository('three-files');
      const git = new GitShellOutStrategy(workingDirPath);
      await git.exec(['remote', 'rm', 'origin']);
      const remotes = await git.getRemotes();
      assert.deepEqual(remotes, []);
    });
  });

  describe('getConfig() and setConfig()', function() {
    it('gets and sets configs', async function() {
      const workingDirPath = await cloneRepository('three-files');
      const git = new GitShellOutStrategy(workingDirPath);
      assert.isNull(await git.getConfig('awesome.devs'));
      await git.setConfig('awesome.devs', 'BinaryMuse,kuychaco,smashwilson');
      assert.equal('BinaryMuse,kuychaco,smashwilson', await git.getConfig('awesome.devs'));
    });
  });

  describe('commit(message, options) where amend option is true', function() {
    it('amends the last commit', async function() {
      const workingDirPath = await cloneRepository('multiple-commits');
      const git = new GitShellOutStrategy(workingDirPath);
      const lastCommit = await git.getHeadCommit();
      const lastCommitParent = await git.getCommit('HEAD~');
      await git.commit('amend last commit', {amend: true, allowEmpty: true});
      const amendedCommit = await git.getHeadCommit();
      const amendedCommitParent = await git.getCommit('HEAD~');
      assert.notDeepEqual(lastCommit, amendedCommit);
      assert.deepEqual(lastCommitParent, amendedCommitParent);
    });
  });

  describe('GPG signing', () => {
    let git;

    beforeEach(async () => {
      const workingDirPath = await cloneRepository('multiple-commits');
      git = new GitShellOutStrategy(workingDirPath);
    });

    const operations = [
      {
        verbalNoun: 'commit',
        progressiveTense: 'committing',
        action: () => git.commit('message'),
      },
      {
        verbalNoun: 'merge',
        progressiveTense: 'merging',
        action: () => git.merge('some-branch'),
      },
      {
        verbalNoun: 'pull',
        progressiveTense: 'pulling',
        action: () => git.pull('some-branch'),
        configureStub: stub => {
          // Stub the `git config` call to resolve the branch's upstream.
          stub.onCall(0).returns(Promise.resolve('origin'));
          return 1;
        },
      },
    ];

    operations.forEach(op => {
      it(`temporarily overrides gpg.program when ${op.progressiveTense}`, async () => {
        const execStub = sinon.stub(git, 'exec');
        let callIndex = 0;
        if (op.configureStub) {
          callIndex = op.configureStub(execStub);
        }
        execStub.returns(Promise.resolve());

        await op.action();

        const callArgs = execStub.getCall(callIndex).args;
        const execArgs = callArgs[0];
        assert.equal(execArgs[0], '-c');
        assert.match(execArgs[1], /^gpg\.program=.*gpg-no-tty\.sh$/);
        assert.isNotOk(callArgs[1].stdin);
        assert.isNotOk(callArgs[1].useGitPromptServer);
      });

      it(`retries a ${op.verbalNoun} with a GitPromptServer when GPG signing fails`, async () => {
        const gpgErr = new GitError('Mock GPG failure');
        gpgErr.stdErr = 'stderr includes "gpg failed"';
        gpgErr.code = 128;

        let callIndex = 0;
        const execStub = sinon.stub(git, 'exec');
        if (op.configureStub) {
          callIndex = op.configureStub(execStub);
        }
        execStub.onCall(callIndex).returns(Promise.reject(gpgErr));
        execStub.returns(Promise.resolve());

        try {
          await op.action();
        } catch (err) {
          assert.fail('expected op.action() not to throw the mock error');
        }

        const callArgs0 = execStub.getCall(callIndex).args;
        const execArgs0 = callArgs0[0];
        assert.equal(execArgs0[0], '-c');
        assert.match(execArgs0[1], /^gpg\.program=.*gpg-no-tty\.sh$/);
        assert.isNotOk(callArgs0[1].stdin);
        assert.isNotOk(callArgs0[1].useGitPromptServer);

        const callArgs1 = execStub.getCall(callIndex + 1).args;
        const execArgs1 = callArgs1[0];
        assert.equal(execArgs1[0], '-c');
        assert.match(execArgs1[1], /^gpg\.program=.*gpg-no-tty\.sh$/);
        assert.isNotOk(callArgs1[1].stdin);
        assert.isTrue(callArgs1[1].useGitPromptServer);
      });
    });
  });

  describe('createBlob({filePath})', () => {
    it('creates a blob for the file path specified and returns its sha', async () => {
      const workingDirPath = await cloneRepository('three-files');
      const git = new GitShellOutStrategy(workingDirPath);
      fs.writeFileSync(path.join(workingDirPath, 'a.txt'), 'qux\nfoo\nbar\n', 'utf8');
      const sha = await git.createBlob({filePath: 'a.txt'});
      assert.equal(sha, 'c9f54222977c93ea17ba4a5a53c611fa7f1aaf56');
      const contents = await git.exec(['cat-file', '-p', sha]);
      assert.equal(contents, 'qux\nfoo\nbar\n');
    });

    it('creates a blob for the stdin specified and returns its sha', async () => {
      const workingDirPath = await cloneRepository('three-files');
      const git = new GitShellOutStrategy(workingDirPath);
      const sha = await git.createBlob({stdin: 'foo\n'});
      assert.equal(sha, '257cc5642cb1a054f08cc83f2d943e56fd3ebe99');
      const contents = await git.exec(['cat-file', '-p', sha]);
      assert.equal(contents, 'foo\n');
    });
  });

  describe('expandBlobToFile(absFilePath, sha)', () => {
    it('restores blob contents for sha to specified file path', async () => {
      const workingDirPath = await cloneRepository('three-files');
      const git = new GitShellOutStrategy(workingDirPath);
      const absFilePath = path.join(workingDirPath, 'a.txt');
      fs.writeFileSync(absFilePath, 'qux\nfoo\nbar\n', 'utf8');
      const sha = await git.createBlob({filePath: 'a.txt'});
      fs.writeFileSync(absFilePath, 'modifications', 'utf8');
      await git.expandBlobToFile(absFilePath, sha);
      assert.equal(fs.readFileSync(absFilePath), 'qux\nfoo\nbar\n');
    });
  });

  describe('getBlobContents(sha)', () => {
    it('returns blob contents for sha', async () => {
      const workingDirPath = await cloneRepository('three-files');
      const git = new GitShellOutStrategy(workingDirPath);
      const sha = await git.createBlob({stdin: 'foo\nbar\nbaz\n'});
      const contents = await git.getBlobContents(sha);
      assert.equal(contents, 'foo\nbar\nbaz\n');
    });
  });

  describe('getFileMode(filePath)', () => {
    it('returns the file mode of the specified file', async () => {
      const workingDirPath = await cloneRepository('three-files');
      const git = new GitShellOutStrategy(workingDirPath);
      const absFilePath = path.join(workingDirPath, 'a.txt');
      fs.writeFileSync(absFilePath, 'qux\nfoo\nbar\n', 'utf8');

      assert.equal(await git.getFileMode('a.txt'), '100644');

      await git.exec(['update-index', '--chmod=+x', 'a.txt']);
      assert.equal(await git.getFileMode('a.txt'), '100755');
    });
  });

  describe('merging files', () => {
    describe('mergeFile(currentPath, basePath, otherPath, resultPath)', () => {
      it('merges current/base/otherPaths and writes to resultPath, returning {filePath, resultPath, conflicts}', async () => {
        const workingDirPath = await cloneRepository('three-files');
        const git = new GitShellOutStrategy(workingDirPath);

        // current and other paths are the same, so no conflicts
        const resultsWithoutConflict = await git.mergeFile('a.txt', 'b.txt', 'a.txt', 'results-without-conflict.txt');
        assert.deepEqual(resultsWithoutConflict, {
          filePath: 'a.txt',
          resultPath: 'results-without-conflict.txt',
          conflict: false,
        });
        assert.equal(fs.readFileSync('results-without-conflict.txt', 'utf8'), fs.readFileSync(path.join(workingDirPath, 'a.txt'), 'utf8'));

        // contents of current and other paths conflict
        const resultsWithConflict = await git.mergeFile('a.txt', 'b.txt', 'c.txt', 'results-with-conflict.txt');
        assert.deepEqual(resultsWithConflict, {
          filePath: 'a.txt',
          resultPath: 'results-with-conflict.txt',
          conflict: true,
        });
        const contents = fs.readFileSync('results-with-conflict.txt', 'utf8');
        assert.isTrue(contents.includes('<<<<<<<'));
        assert.isTrue(contents.includes('>>>>>>>'));
      });
    });

    describe('udpateIndex(filePath, commonSha, oursSha, theirsSha)', () => {
      it('updates the index to have the appropriate shas, retaining the original file mode', async () => {
        const workingDirPath = await cloneRepository('three-files');
        const git = new GitShellOutStrategy(workingDirPath);
        const absFilePath = path.join(workingDirPath, 'a.txt');
        fs.writeFileSync(absFilePath, 'qux\nfoo\nbar\n', 'utf8');
        await git.exec(['update-index', '--chmod=+x', 'a.txt']);

        const commonSha = '7f95a814cbd9b366c5dedb6d812536dfef2fffb7';
        const oursSha = '95d4c5b7b96b3eb0853f586576dc8b5ac54837e0';
        const theirsSha = '5da808cc8998a762ec2761f8be2338617f8f12d9';
        await git.updateIndex('a.txt', commonSha, oursSha, theirsSha);

        const index = await git.exec(['ls-files', '--stage', '--', 'a.txt']);
        assert.equal(index.trim(), dedent`
          100755 ${commonSha} 1\ta.txt
          100755 ${oursSha} 2\ta.txt
          100755 ${theirsSha} 3\ta.txt
        `);
      });
    });
  });
});
