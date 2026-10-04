import {describe,it,expect} from 'vitest'
import {shapeMotifMcpResult} from './motifResult'
describe('Motif result transport',()=>{
  it('keeps the catalog small and preserves revision records',()=>{
    const list=shapeMotifMcpResult('list_motifs',[{id:'a',html:'large',revision:'r'}])
    expect(JSON.parse(list.content[0].text)).toEqual([{id:'a',revision:'r'}])
    for(const name of ['open_motif_draft','update_motif_files','install_motif','export_motif','read_motif']){
      const record={draft_id:'a',revision:'r'}
      expect(shapeMotifMcpResult(name,record).structuredContent).toEqual(record)
    }
  })
})
