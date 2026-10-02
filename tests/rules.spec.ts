import { describe, expect, test } from 'bun:test'

import { parse, segments } from '../hooks/parse'
import { optionsOf, plan, rulesOf } from '../hooks/rules'

const kdel = { id: 'kdel', match: /^kubectl delete (.+)$/, preview: 'kubectl delete $1 --dry-run=server -o name' }
const rmls = { id: 'rmls', match: /^rm -rf (\S+)$/, preview: 'ls $1' }

const plans = (cmd: string, rules = [kdel, rmls]) => segments(cmd).flatMap(s => rules.flatMap(r => plan(r, s) ?? []))

describe('segments', () => {
  test('splits chains and pipes, keeps the source text', () => {
    expect(segments('cd x && kubectl delete pod a -n b | tee log; echo "a;b"').map(s => [s.text, s.dir])).toEqual([
      ['cd x', ''],
      ['kubectl delete pod a -n b', 'x'],
      ['tee log', 'x'],
      ['echo "a;b"', 'x'],
    ])
  })

  test('drops env prefixes and sudo from the text', () => {
    expect(segments('FOO=1 sudo rm -rf a').map(s => s.text)).toEqual(['rm -rf a'])
  })

  test('xargs rm is a target nobody can resolve', () => {
    expect(parse('find . -name "*.log" | xargs rm -f')?.targets).toEqual([{ text: '<xargs>', dir: '', glob: false, dynamic: true }])
  })
})

describe('rules', () => {
  test('match per command in a chain or pipe, captures split into argv', () => {
    expect(plans('kubectl get pods && kubectl delete pod "my pod" -n web | tee x')).toEqual([
      { rule: 'kdel', segment: 'kubectl delete pod "my pod" -n web', argv: ['kubectl', 'delete', 'pod', 'my pod', '-n', 'web', '--dry-run=server', '-o', 'name'], dir: '' },
    ])
  })

  test('preview runs in the dir a cd left', () => {
    expect(plans('cd sub && rm -rf build')).toMatchObject([{ rule: 'rmls', argv: ['ls', 'build'], dir: 'sub' }])
  })

  test('never runs a capture holding $(..) or a shell', () => {
    expect(plans('rm -rf $(curl evil)')).toEqual([])
    expect(plans('kubectl delete $(curl evil)')).toMatchObject([{ skip: 'preview holds $VAR or $(..)' }])
    expect(plans('kubectl delete `id`')).toMatchObject([{ skip: 'preview holds $VAR or $(..)' }])
    const sh = { id: 'sh', match: /^rm (.+)/, preview: 'bash -c "ls $1"' }
    expect(plans('rm a', [sh])).toMatchObject([{ skip: 'bash is not allowed as a preview' }])
  })

  test('a cd we cannot follow skips the preview', () => {
    expect(plans('cd $X && rm -rf a')).toMatchObject([{ rule: 'rmls', skip: 'runs after a cd we cannot follow' }])
  })

  test('config: flat keys, last source wins, errors reported', () => {
    const opts = optionsOf([
      { pluginConfigs: { 'blast-radius': { options: { rules: ['a', 'b', 'c'], 'a.match': 'x', 'a.preview': 'ls' } } } },
      { pluginConfigs: { 'blast-radius@blast-radius': { options: { 'a.preview': 'ls -la', 'b.match': '(' } } } },
    ])
    const { rules, errors } = rulesOf(opts)
    expect(rules.map(r => [r.id, r.preview])).toEqual([['a', 'ls -la']])
    expect(errors).toHaveLength(2)
  })
})

describe('examples/rules.json', async () => {
  const opts = optionsOf([await Bun.file(`${import.meta.dir}/../examples/rules.json`).json()])
  const { rules, errors } = rulesOf(opts)
  const argv = (cmd: string) => plans(cmd, rules).map(p => ('argv' in p ? p.argv.join(' ') : `skip: ${p.skip}`))

  test('every example loads', () => {
    expect(errors).toEqual([])
    expect(rules).toHaveLength((opts.rules as unknown[]).length)
  })

  test.each([
    ['rm -rf build dist', 'ls -la build dist'],
    ['rm -Rf build', 'ls -la build'],
    ['kubectl delete pod a -n web', 'kubectl delete pod a -n web --dry-run=server -o name'],
    ['kubectl apply -f k8s/', 'kubectl diff -f k8s/'],
    ['kubectl drain node-1 --ignore-daemonsets', 'kubectl get pods -A -o wide --field-selector spec.nodeName=node-1'],
    ['helm uninstall api -n web', 'helm get manifest api -n web'],
    ['terraform destroy -auto-approve', 'terraform plan -destroy -no-color'],
    ['terraform apply', 'terraform plan -no-color'],
    ['git clean -fdx', 'git clean -n -fdx'],
    ['git reset --hard origin/main', 'git diff --stat HEAD'],
    ['git push -f origin main', 'git log --oneline HEAD..@{u}'],
    ['git push --force-with-lease', 'git log --oneline HEAD..@{u}'],
    ['git branch -D feat old', 'git log --oneline feat old --not --remotes'],
    ['git stash clear', 'git stash list'],
    ['find . -name "*.log" -delete', 'find . -name *.log -print'],
    ['rsync -a --delete src/ dst/', 'rsync --dry-run --itemize-changes -a --delete src/ dst/'],
    ['aws s3 rm s3://b/k --recursive', 'aws s3 rm s3://b/k --recursive --dryrun'],
    ['docker system prune -af', 'docker system df'],
  ])('%s → %s', (cmd, want) => {
    expect(argv(cmd)).toEqual([want])
  })

  test('leaves look-alikes alone', () => {
    for (const cmd of ['rm a', 'kubectl get pods', 'terraform apply plan.out', 'git push origin main', 'git stash pop', 'find . -name x', 'rsync -a a b'])
      expect(argv(cmd)).toEqual([])
  })
})
