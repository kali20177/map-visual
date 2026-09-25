/* Minimal layout for the shellCommand fixture: collects a dot-less custom
 * input section alongside the regular ones. */
ENTRY(main)

MEMORY
{
  FLASH (rx)  : ORIGIN = 0x08000000, LENGTH = 128K
  RAM   (rwx) : ORIGIN = 0x20000000, LENGTH = 20K
}

SECTIONS
{
  .text :
  {
    *(.text*)
    *(shellCommand)
    *(.rodata*)
    . = ALIGN(4);
    _etext = .;
  } > FLASH

  .data :
  {
    *(.data*)
  } > RAM AT> FLASH

  .bss (NOLOAD) :
  {
    *(.bss*)
    *(COMMON)
  } > RAM
}
