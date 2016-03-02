/** @babel */

import path from 'path'
import fs from 'fs-plus'
import FileList from '../lib/file-list'
import GitService from '../lib/git-service'
import FileDiffViewModel from '../lib/file-diff-view-model'
import {copyRepository} from './helpers'
import {waitsForPromise} from './async-spec-helpers'

async function createDiffViewModel (fileName) {
  const fileList = new FileList([], {stageOnChange: false})
  await fileList.loadFromGitUtils()
  const fileDiff = fileList.getFileFromPathName(fileName)
  expect(fileDiff).toBeDefined()

  return new FileDiffViewModel(fileDiff)
}

describe('FileDiffViewModel', function () {
  const fileName = 'README.md'
  let filePath

  let repoPath

  beforeEach(() => {
    repoPath = copyRepository()

    GitService.instance().repoPath = repoPath

    filePath = path.join(repoPath, fileName)
  })

  describe('.getTitle', () => {
    it('is the name of the changed files', () => {
      fs.writeFileSync(filePath, 'how now brown cow')

      let viewModel
      waitsForPromise(() => createDiffViewModel(fileName).then(v => viewModel = v))
      runs(() => {
        expect(viewModel.getTitle()).toBe(fileName)
      })
    })

    it('contains both the old and new name for renames', () => {
      const newFileName = 'REAMDE.md'
      fs.moveSync(filePath, path.join(repoPath, newFileName))

      let viewModel
      waitsForPromise(() => createDiffViewModel(newFileName).then(v => viewModel = v))
      runs(() => {
        const title = viewModel.getTitle()
        expect(title).toContain(fileName)
        expect(title).toContain(newFileName)
      })
    })
  })
})
