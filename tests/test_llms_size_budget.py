import io,sys,tempfile,unittest
from contextlib import redirect_stdout
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'atlas/site'))
import check

class LlmsSizeBudget(unittest.TestCase):
    def setUp(self):
        self.t=tempfile.TemporaryDirectory();self.d=Path(self.t.name)
        self.put('llms.txt',10);self.put('llms-full.txt',10)
    def tearDown(self):self.t.cleanup()
    def put(self,name,n,ch='a'):(self.d/name).write_text(ch*n,encoding='utf-8')
    def run_checks(self):
        buf=io.StringIO()
        with redirect_stdout(buf):fails=check.llms_size_checks(str(self.d))
        return fails,buf.getvalue()
    def test_budgets_are_the_agreed_numbers(self):
        self.assertEqual((check.LLMS_WARN_CHARS,check.LLMS_FAIL_CHARS),(1_000_000,1_500_000))
    def test_small_files_pass_quietly(self):
        self.assertEqual(self.run_checks(),([],''))
    def test_below_warning_is_quiet(self):
        self.put('llms-full.txt',999_999);self.assertEqual(self.run_checks(),([],''))
    def test_warning_from_one_million_does_not_fail(self):
        self.put('llms-full.txt',1_000_000);fails,out=self.run_checks()
        self.assertEqual(fails,[]);self.assertIn('WARNING',out);self.assertIn('llms-full.txt',out)
    def test_exactly_the_fail_limit_only_warns(self):
        self.put('llms-full.txt',1_500_000);fails,out=self.run_checks()
        self.assertEqual(fails,[]);self.assertIn('WARNING',out)
    def test_above_the_fail_limit_fails_with_a_reason(self):
        self.put('llms-full.txt',1_500_001);fails,_=self.run_checks()
        self.assertEqual(len(fails),1);self.assertIn('/llms-full.txt',fails[0]);self.assertIn('2,000,000',fails[0])
    def test_llms_txt_is_checked_too(self):
        self.put('llms.txt',1_600_000);fails,_=self.run_checks()
        self.assertEqual(len(fails),1);self.assertIn('/llms.txt ',fails[0])
    def test_missing_file_fails(self):
        (self.d/'llms.txt').unlink();fails,_=self.run_checks();self.assertEqual(len(fails),1)
    def test_counts_utf16_units_like_the_worker(self):
        self.put('llms-full.txt',750_001,'\U0001F600')  # 2 units each in JavaScript: 1,500,002
        fails,_=self.run_checks();self.assertEqual(len(fails),1)

if __name__=='__main__':unittest.main()
