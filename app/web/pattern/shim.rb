# The four things this runtime does not have, and the pattern library needs.
#
# Loaded as a program into the session (never by patching the runtime): every patch here lives in the session and vanishes
# with it. Each one was found by measurement, and each one's absence is a hard failure rather than a slowdown:
#
#   1. Thread.current -- pattern-lib.rb keeps a flag there (Mini#keep_rests?). mruby has no Thread at all.
#   2. Rational#ceil / #floor / #% -- rational time is built on them and mruby-rational lacks all three.
#      #round must keep its ndigits argument: the runtime itself calls p.time.round(6), and a zero-argument override
#      makes every run fail before its body starts, with no error record at all.
#   3. String#strip -- the library's spec parser calls it, and this gem set does not have it.
#   4. Patches to core classes can only be made with class_eval("..."), not `class String` in a program: a program's class
#      definitions build a sandbox shadow and patch nothing (measured: `class Integer; def hi; end` then `3.hi` fails).
#
# A last check follows the patches: if any of them did not take, this raises once, with all of it named, rather than
# letting the library fail later with a NoMethodError that says nothing about why.

$__patterns_thread_local = {}

class Thread
  def self.current = $__patterns_thread_local
end

Rational.class_eval("def floor; numerator.div(denominator); end")
Rational.class_eval("def ceil; q = numerator.div(denominator); rem = numerator - q * denominator; rem > 0 ? q + 1 : q; end")
Rational.class_eval("def round(ndigits = 0); ndigits <= 0 ? (self + Rational(1, 2)).floor : to_f.round(ndigits); end")
Rational.class_eval("def %(other); self - (self / other).floor * other; end")

String.class_eval do
  WS = [" ", "\t", "\n", "\r"]
  def strip
    s = self
    s = s[1..-1] while s.length > 0 && WS.include?(s[0])
    s = s[0..-2] while s.length > 0 && WS.include?(s[-1])
    s
  end
end

__pattern_shim_missing = []
__pattern_shim_missing << "Thread.current" unless (defined?(Thread) && Thread.respond_to?(:current))
__pattern_shim_missing << "Rational#ceil" unless (3r / 2).respond_to?(:ceil)
__pattern_shim_missing << "Rational#floor" unless (3r / 2).respond_to?(:floor)
__pattern_shim_missing << "Rational#%" unless (3r / 2).respond_to?(:%)
__pattern_shim_missing << "Rational#round(6)" unless ((3r / 2).round(6) rescue nil).nil? == false
__pattern_shim_missing << "String#strip" unless " x ".respond_to?(:strip)
raise "pattern shim incomplete: " + __pattern_shim_missing.join(", ") unless __pattern_shim_missing.empty?

"shim ok"
