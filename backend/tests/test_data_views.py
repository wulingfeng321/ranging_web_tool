import csv
import io
from app.analysis import read_capture
from app.data_views import TABLES, table_count, table_page, table_rows, csv_chunks
from test_analysis import write_fixture

def test_metadata_exact_and_catalog_complete(tmp_path):
    boards,_=read_capture(write_fixture(tmp_path))
    page=table_page(boards['A'],'metadata',0,50)
    assert next(r['value'] for r in page['rows'] if r['field']=='session')==str(2**63+7)
    assert {r['key'] for r in page['catalog']}==set(TABLES)
    assert all(isinstance(value,str) for row in page['rows'] for value in row.values())

def test_anchor_and_pcm_pagination_keep_original_samples(tmp_path):
    boards,_=read_capture(write_fixture(tmp_path))
    board=boards['A']
    page=table_page(board,'anchors',5,2)
    assert page['total']==10
    assert page['rows'][0]=={'wav_frame_end':'288','absolute_sample_end':'288','local_anchor_ns':'1006000000','audio_epoch':'1','block_frames':'48'}
    pcm=table_page(board,'pcm',100,2)
    assert pcm['total']==480
    assert [r['ch1'] for r in pcm['rows']]==['30000','-29000']
    assert [r['ch2'] for r in pcm['rows']]==['0','0']
    assert table_page(board,'pcm',479,50)['rows'][0]['frame_index']=='479'
    assert len(table_page(board,'pcm',479,50)['rows'])==1

def test_log_order_and_every_field_preserved(tmp_path):
    boards,_=read_capture(write_fixture(tmp_path))
    board=boards['A']
    rows=list(table_rows(board,'logs'))
    assert [r['record_type'] for r in rows]==['event','clock','candidate','event','clock','pair']
    assert rows[0]['record']=='event,1,1001000000,800,1'
    assert rows[-1]['record_number']=='6'
    for kind,raw_rows in board['logs'].items():
        assert list(table_rows(board,kind))==raw_rows
    assert table_page(board,'wave_clock',0,50)['rows']==[]
    assert table_page(board,'wave_clock',0,50)['columns'][0]['key']=='period_ps'

def test_csv_exports_whole_table_and_original_precision(tmp_path):
    boards,_=read_capture(write_fixture(tmp_path))
    for table in TABLES:
        text=''.join(csv_chunks(boards['A'],table))
        records=list(csv.DictReader(io.StringIO(text.lstrip('\ufeff'))))
        assert len(records)==table_count(boards['A'],table)
        assert records==list(table_rows(boards['A'],table))
