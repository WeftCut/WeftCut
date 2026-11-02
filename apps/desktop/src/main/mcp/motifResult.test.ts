import {describe,it,expect} from 'vitest'
import {agentMotifRow,shapeMotifMcpResult} from './motifResult'
describe('Motif result transport',()=>{
  it('keeps the catalog small: no html, and one revision field (ME20)',()=>{
    const list=shapeMotifMcpResult('list_motifs',[{id:'a',html:'large',content_hash:'r',revision:'r'}])
    expect(JSON.parse(list.content[0].text)).toEqual([{id:'a',revision:'r'}])
    expect(agentMotifRow({id:'a',html:'x',content_hash:'r',revision:'r',publication:{state:'awaiting_approval'}})).toEqual({id:'a',revision:'r',publication:{state:'awaiting_approval'}})
    for(const name of ['open_motif_draft','update_motif_files','install_motif','export_motif','read_motif']){
      const record={motif_id:'a',revision:'r'}
      expect(shapeMotifMcpResult(name,record).structuredContent).toEqual(record)
    }
  })
})
